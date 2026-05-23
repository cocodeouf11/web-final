from dotenv import load_dotenv
from pathlib import Path
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import io
import uuid
import base64
import random
import string
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, List

import bcrypt
import jwt
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, Response, UploadFile, File as UploadFileParam, Form
from fastapi.responses import FileResponse, Response as FastAPIResponse
from starlette.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import select, delete, func
from sqlalchemy.ext.asyncio import AsyncSession
from PIL import Image
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.lib.utils import ImageReader

from db import init_db, AsyncSessionLocal, User, File as FileModel, DocumentType, user_to_dict, file_to_dict
from config import USERS, ROLES, SYNC_PASSWORDS, SYNC_DELETE_MISSING, MAX_PDF_SIZE_MB, ACCESS_CODE_PREFIX

# ---------- Constants ----------
JWT_ALGORITHM = "HS256"
JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret-change-me")

# ---------- App ----------
app = FastAPI()
api_router = APIRouter(prefix="/api")
logger = logging.getLogger("server")
logging.basicConfig(level=logging.INFO)


# ---------- DB session dependency ----------
async def get_db():
    async with AsyncSessionLocal() as session:
        yield session


# ---------- Auth helpers ----------
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_access_token(user_id: str, username: str) -> str:
    payload = {
        "sub": user_id,
        "username": username,
        "exp": datetime.now(timezone.utc) + timedelta(hours=8),
        "type": "access",
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def generate_access_code() -> str:
    part1 = ''.join(random.choices(string.digits, k=5))
    part2 = ''.join(random.choices(string.ascii_uppercase, k=2))
    return f"{ACCESS_CODE_PREFIX}-{part1}-{part2}"


def get_role_permissions(role: str) -> list:
    return ROLES.get(role, {}).get("permissions", [])


def get_role_label(role: str) -> str:
    return ROLES.get(role, {}).get("label", role)


async def get_current_admin(request: Request, db: AsyncSession = Depends(get_db)) -> dict:
    token = request.cookies.get("access_token")
    if not token:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
        result = await db.execute(select(User).where(User.id == payload["sub"]))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        return user_to_dict(user)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


async def require_super_admin(user=Depends(get_current_admin)) -> dict:
    if user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Réservé au super admin")
    return user


def is_super_admin(user: dict) -> bool:
    return user.get("role") == "super_admin"


# ---------- Models ----------
class LoginInput(BaseModel):
    username: str
    password: str


class StatusUpdate(BaseModel):
    status: str


class CodeVerify(BaseModel):
    code: str


class SignInput(BaseModel):
    signature_data_url: str


class SignaturePositionUpdate(BaseModel):
    signature_position: str  # one of: top-left, top-center, top-right, middle-left, middle-center, middle-right, bottom-left, bottom-center, bottom-right


class SelfUpdate(BaseModel):
    username: Optional[str] = None
    new_password: Optional[str] = None
    current_password: str  # required to confirm any self-update


class DocumentTypeCreate(BaseModel):
    name: str
    default_signature_position: Optional[str] = "bottom-right"


class DocumentTypeUpdate(BaseModel):
    name: Optional[str] = None
    default_signature_position: Optional[str] = None


class FileTypeUpdate(BaseModel):
    document_type: str


class FileRename(BaseModel):
    filename: str


class FieldsUpdate(BaseModel):
    """Update form fields for a file."""
    fields: list  # list of dicts {name, label, type, page, x, y, width, height, required}


class LinkFileInput(BaseModel):
    """For linking an existing file (parent_id) when uploading a child."""
    parent_id: Optional[str] = None


class LinkExistingInput(BaseModel):
    """Link an existing file (child_id) under a parent."""
    child_id: str


class SignFullInput(BaseModel):
    """Used for signing with form fields + signature."""
    signature_data_url: Optional[str] = None
    field_values: dict = {}  # {field_name: value}
    fait_a: Optional[str] = None  # convenience field for attestation type


VALID_POSITIONS = {
    "top-left", "top-center", "top-right",
    "middle-left", "middle-center", "middle-right",
    "bottom-left", "bottom-center", "bottom-right",
}


class UserCreate(BaseModel):
    username: str
    password: str


class UserUpdate(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None


# ---------- Auth Endpoints ----------
@api_router.post("/auth/login")
async def login(payload: LoginInput, response: Response, db: AsyncSession = Depends(get_db)):
    username = payload.username.strip().lower()
    result = await db.execute(select(User).where(User.username == username))
    user = result.scalar_one_or_none()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Identifiants invalides")
    token = create_access_token(user.id, user.username)
    cookie_secure = os.environ.get("COOKIE_SECURE", "true").lower() == "true"
    cookie_samesite = os.environ.get("COOKIE_SAMESITE", "none" if cookie_secure else "lax")
    response.set_cookie(
        key="access_token", value=token, httponly=True,
        secure=cookie_secure, samesite=cookie_samesite,
        max_age=8 * 3600, path="/",
    )
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "role_label": get_role_label(user.role),
        "permissions": get_role_permissions(user.role),
        "token": token,
    }


@api_router.post("/auth/logout")
async def logout(response: Response):
    response.delete_cookie("access_token", path="/")
    return {"ok": True}


@api_router.get("/auth/me")
async def me(user=Depends(get_current_admin)):
    role = user.get("role", "gestionnaire")
    return {**user, "role_label": get_role_label(role), "permissions": get_role_permissions(role)}


@api_router.patch("/auth/me")
async def update_me(payload: SelfUpdate, user=Depends(get_current_admin), db: AsyncSession = Depends(get_db)):
    """Allow any authenticated user to update their own username and/or password.
    Requires current password to confirm."""
    db_user = (await db.execute(select(User).where(User.id == user["id"]))).scalar_one_or_none()
    if not db_user:
        raise HTTPException(404, "Utilisateur introuvable")
    if not verify_password(payload.current_password, db_user.password_hash):
        raise HTTPException(401, "Mot de passe actuel incorrect")

    changed = []
    # Username change
    if payload.username is not None:
        new_username = payload.username.strip().lower()
        if len(new_username) < 3:
            raise HTTPException(400, "Nom d'utilisateur trop court (min 3 caractères)")
        if new_username != db_user.username:
            clash = (await db.execute(
                select(User).where(User.username == new_username, User.id != db_user.id)
            )).scalar_one_or_none()
            if clash:
                raise HTTPException(400, "Ce nom d'utilisateur existe déjà")
            db_user.username = new_username
            # Propagate to files
            files_to_update = (await db.execute(
                select(FileModel).where(FileModel.created_by == db_user.id)
            )).scalars().all()
            for f in files_to_update:
                f.created_by_username = new_username
            changed.append("username")

    # Password change
    if payload.new_password is not None and payload.new_password != "":
        if len(payload.new_password) < 6:
            raise HTTPException(400, "Nouveau mot de passe trop court (min 6 caractères)")
        db_user.password_hash = hash_password(payload.new_password)
        changed.append("password")

    if not changed:
        return {"ok": True, "updated": False}

    await db.commit()
    return {
        "ok": True,
        "updated": True,
        "changed": changed,
        "username": db_user.username,
        "warning": (
            "Note : ces changements seront écrasés au prochain redémarrage si SYNC_PASSWORDS=True dans config.py "
            "et que le mot de passe défini dans config.py est différent. "
            "Pensez à mettre à jour config.py également pour conserver vos changements après redémarrage."
            if "password" in changed else None
        ),
    }


# ---------- Files ----------
@api_router.post("/files/upload")
async def upload_file(
    file: UploadFile = UploadFileParam(...),
    document_type: str = Form("Devis"),
    parent_id: Optional[str] = Form(None),
    user=Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Seuls les fichiers PDF sont acceptés")
    content = await file.read()
    if len(content) > MAX_PDF_SIZE_MB * 1024 * 1024:
        raise HTTPException(status_code=400, detail=f"Fichier trop volumineux (max {MAX_PDF_SIZE_MB}MB)")

    doc_type_name = (document_type or "Devis").strip() or "Devis"
    default_pos = "bottom-right"
    type_row = (await db.execute(select(DocumentType).where(DocumentType.name == doc_type_name))).scalar_one_or_none()
    if type_row:
        default_pos = type_row.default_signature_position

    parent_file = None
    sort_order = 0
    if parent_id:
        parent_q = select(FileModel).where(FileModel.id == parent_id)
        parent_q = _files_filter(parent_q, user)
        parent_file = (await db.execute(parent_q)).scalar_one_or_none()
        if not parent_file:
            raise HTTPException(404, "Document parent introuvable")
        # Use grandparent as actual parent if parent itself is a child
        actual_parent_id = parent_file.parent_file_id or parent_file.id
        existing_children = (await db.execute(
            select(func.count()).select_from(FileModel).where(FileModel.parent_file_id == actual_parent_id)
        )).scalar_one()
        sort_order = existing_children + 1
        parent_id = actual_parent_id

    # Default fields preset for Attestation type
    import json as _json
    default_fields = _attestation_fields() if doc_type_name.lower() == "attestation" else []

    file_id = str(uuid.uuid4())
    new_file = FileModel(
        id=file_id,
        filename=file.filename,
        content_b64=base64.b64encode(content).decode("utf-8"),
        size=len(content),
        status="unsigned",
        access_code=None,
        created_by=user["id"],
        created_by_username=user["username"],
        created_at=datetime.now(timezone.utc).isoformat(),
        signed_at=None,
        signed_content_b64=None,
        signature_position=default_pos,
        document_type=doc_type_name,
        parent_file_id=parent_id,
        fields=_json.dumps(default_fields) if default_fields else None,
        sort_order=sort_order,
    )
    db.add(new_file)
    await db.commit()
    return file_to_dict(new_file)


def _attestation_fields():
    """Preset form fields for Attestation Simplifiée Cerfa N°13948*05 (A4, 595x842pts).
    Coordinates extracted directly from the PDF dotted lines via pdfplumber.
    All fields are on page 1.
    """
    return [
        # Identité — line "Nom :…………… Prénom :……………" at y≈683
        {"name": "nom",         "label": "Nom",         "type": "text", "page": 1, "x": 80,  "y": 683, "width": 170, "height": 14, "required": True},
        {"name": "prenom",      "label": "Prénom",      "type": "text", "page": 1, "x": 312, "y": 683, "width": 195, "height": 14, "required": True},
        # Line "Adresse :…… Code postal :… Commune ……" at y≈673
        {"name": "adresse",     "label": "Adresse",     "type": "text", "page": 1, "x": 92,  "y": 673, "width": 160, "height": 14, "required": True},
        {"name": "code_postal", "label": "Code postal", "type": "text", "page": 1, "x": 325, "y": 673, "width": 35,  "height": 14, "required": True},
        {"name": "commune",     "label": "Commune",     "type": "text", "page": 1, "x": 401, "y": 673, "width": 110, "height": 14, "required": True},
        # Bottom: "Fait à…………, le……………." at y≈163
        {"name": "fait_a",      "label": "Fait à",      "type": "text",      "page": 1, "x": 263, "y": 163, "width": 90, "height": 14, "required": True},
        {"name": "le_date",     "label": "Le",          "type": "date_auto", "page": 1, "x": 368, "y": 163, "width": 55, "height": 14, "required": False},
        # Signature anchor below "Signature du client ou de son représentant :"
        {"name": "__signature__","label":"Signature",   "type": "signature", "page": 1, "x": 320, "y": 70,  "width": 210, "height": 60, "required": True},
    ]


def _files_filter(query, user: dict):
    if not is_super_admin(user):
        return query.where(FileModel.created_by == user["id"])
    return query


@api_router.get("/files")
async def list_files(user=Depends(get_current_admin), db: AsyncSession = Depends(get_db)):
    q = select(FileModel).order_by(FileModel.created_at.desc())
    q = _files_filter(q, user)
    result = await db.execute(q)
    return [file_to_dict(f) for f in result.scalars().all()]


@api_router.get("/files/{file_id}")
async def get_file_meta(file_id: str, user=Depends(get_current_admin), db: AsyncSession = Depends(get_db)):
    q = select(FileModel).where(FileModel.id == file_id)
    q = _files_filter(q, user)
    f = (await db.execute(q)).scalar_one_or_none()
    if not f:
        raise HTTPException(404, "Fichier introuvable")
    return file_to_dict(f)


@api_router.get("/files/{file_id}/download")
async def download_file(file_id: str, signed: bool = False, user=Depends(get_current_admin), db: AsyncSession = Depends(get_db)):
    q = select(FileModel).where(FileModel.id == file_id)
    q = _files_filter(q, user)
    f = (await db.execute(q)).scalar_one_or_none()
    if not f:
        raise HTTPException(404, "Fichier introuvable")
    use_signed = signed and f.signed_content_b64
    content_b64 = f.signed_content_b64 if use_signed else f.content_b64
    filename = f.signed_filename if (use_signed and f.signed_filename) else f.filename
    return {"filename": filename, "content_b64": content_b64}


@api_router.delete("/files/{file_id}")
async def delete_file(file_id: str, user=Depends(get_current_admin), db: AsyncSession = Depends(get_db)):
    q = select(FileModel).where(FileModel.id == file_id)
    q = _files_filter(q, user)
    f = (await db.execute(q)).scalar_one_or_none()
    if not f:
        raise HTTPException(404, "Fichier introuvable")
    await db.delete(f)
    await db.commit()
    return {"ok": True}


@api_router.patch("/files/{file_id}/status")
async def update_status(file_id: str, payload: StatusUpdate, user=Depends(get_current_admin), db: AsyncSession = Depends(get_db)):
    if payload.status not in ("signed", "unsigned"):
        raise HTTPException(400, "Statut invalide")
    q = select(FileModel).where(FileModel.id == file_id)
    q = _files_filter(q, user)
    f = (await db.execute(q)).scalar_one_or_none()
    if not f:
        raise HTTPException(404, "Fichier introuvable")
    f.status = payload.status
    await db.commit()
    return {"ok": True, "status": payload.status}


@api_router.post("/files/{file_id}/generate-code")
async def generate_code(file_id: str, user=Depends(get_current_admin), db: AsyncSession = Depends(get_db)):
    q = select(FileModel).where(FileModel.id == file_id)
    q = _files_filter(q, user)
    f = (await db.execute(q)).scalar_one_or_none()
    if not f:
        raise HTTPException(404, "Fichier introuvable")
    for _ in range(20):
        code = generate_access_code()
        clash = (await db.execute(select(FileModel).where(FileModel.access_code == code))).scalar_one_or_none()
        if not clash:
            break
    else:
        raise HTTPException(500, "Impossible de générer un code unique")
    f.access_code = code
    await db.commit()
    return {"access_code": code}


@api_router.patch("/files/{file_id}/signature-position")
async def update_signature_position(
    file_id: str,
    payload: SignaturePositionUpdate,
    user=Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    if payload.signature_position not in VALID_POSITIONS:
        raise HTTPException(400, "Position invalide")
    q = select(FileModel).where(FileModel.id == file_id)
    q = _files_filter(q, user)
    f = (await db.execute(q)).scalar_one_or_none()
    if not f:
        raise HTTPException(404, "Fichier introuvable")
    if f.status == "signed":
        raise HTTPException(400, "Impossible de modifier la position d'un document déjà signé")
    f.signature_position = payload.signature_position
    await db.commit()
    return {"ok": True, "signature_position": payload.signature_position}


@api_router.patch("/files/{file_id}/document-type")
async def update_document_type(
    file_id: str,
    payload: FileTypeUpdate,
    user=Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    new_type = (payload.document_type or "").strip()
    if not new_type:
        raise HTTPException(400, "Type invalide")
    q = select(FileModel).where(FileModel.id == file_id)
    q = _files_filter(q, user)
    f = (await db.execute(q)).scalar_one_or_none()
    if not f:
        raise HTTPException(404, "Fichier introuvable")
    f.document_type = new_type
    if f.status != "signed":
        type_row = (await db.execute(select(DocumentType).where(DocumentType.name == new_type))).scalar_one_or_none()
        if type_row:
            f.signature_position = type_row.default_signature_position
        # Refresh attestation preset if user changes type to Attestation
        import json as _json
        if new_type.lower() == "attestation" and not f.fields:
            f.fields = _json.dumps(_attestation_fields())
    await db.commit()
    return {"ok": True, "document_type": new_type, "signature_position": f.signature_position}


@api_router.patch("/files/{file_id}/rename")
async def rename_file(
    file_id: str,
    payload: FileRename,
    user=Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Rename a file. Keeps the '.pdf' extension. If this is a parent (folder root),
    refresh children's `signed_filename` so the combined `{parent}+{child}.pdf` stays consistent.
    """
    new_name = (payload.filename or "").strip()
    if not new_name:
        raise HTTPException(400, "Nom invalide")
    if not new_name.lower().endswith(".pdf"):
        new_name = new_name + ".pdf"
    if len(new_name) > 250:
        raise HTTPException(400, "Nom trop long (max 250 caractères)")

    q = select(FileModel).where(FileModel.id == file_id)
    q = _files_filter(q, user)
    f = (await db.execute(q)).scalar_one_or_none()
    if not f:
        raise HTTPException(404, "Fichier introuvable")

    old_name = f.filename
    f.filename = new_name

    # Refresh combined signed_filename for children if this is a folder root
    if not f.parent_file_id:
        children = (await db.execute(
            select(FileModel).where(FileModel.parent_file_id == f.id)
        )).scalars().all()
        parent_base = os.path.splitext(new_name)[0]
        for c in children:
            if c.signed_filename:
                child_base = os.path.splitext(c.filename or "doc")[0]
                c.signed_filename = f"{parent_base}+{child_base}.pdf"

    # If this is a child, refresh its own signed_filename relative to its parent's current name
    if f.parent_file_id and f.signed_filename:
        parent = (await db.execute(
            select(FileModel).where(FileModel.id == f.parent_file_id)
        )).scalar_one_or_none()
        if parent:
            parent_base = os.path.splitext(parent.filename or "doc")[0]
            child_base = os.path.splitext(new_name)[0]
            f.signed_filename = f"{parent_base}+{child_base}.pdf"

    await db.commit()
    return {"ok": True, "filename": new_name, "previous": old_name}



@api_router.patch("/files/{file_id}/fields")
async def update_file_fields(
    file_id: str,
    payload: FieldsUpdate,
    user=Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Update form-fields layout (positions, labels) for a file."""
    import json as _json
    q = select(FileModel).where(FileModel.id == file_id)
    q = _files_filter(q, user)
    f = (await db.execute(q)).scalar_one_or_none()
    if not f:
        raise HTTPException(404, "Fichier introuvable")
    if f.status == "signed":
        raise HTTPException(400, "Document déjà signé")
    f.fields = _json.dumps(payload.fields)
    await db.commit()
    return {"ok": True, "count": len(payload.fields)}


@api_router.get("/files/{file_id}/linked")
async def list_linked(file_id: str, user=Depends(get_current_admin), db: AsyncSession = Depends(get_db)):
    """List child documents linked to a parent (admin view)."""
    q = select(FileModel).where(FileModel.id == file_id)
    q = _files_filter(q, user)
    f = (await db.execute(q)).scalar_one_or_none()
    if not f:
        raise HTTPException(404, "Fichier introuvable")
    children_q = select(FileModel).where(FileModel.parent_file_id == file_id).order_by(FileModel.sort_order)
    children_q = _files_filter(children_q, user)
    children = (await db.execute(children_q)).scalars().all()
    return [file_to_dict(c) for c in children]


@api_router.post("/files/{file_id}/link-existing")
async def link_existing_file(
    file_id: str,
    payload: LinkExistingInput,
    user=Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Attach an EXISTING (already uploaded) file as child of the parent file_id.
    Both must be visible to the user; child must not already have a parent.
    """
    parent_q = select(FileModel).where(FileModel.id == file_id)
    parent_q = _files_filter(parent_q, user)
    parent = (await db.execute(parent_q)).scalar_one_or_none()
    if not parent:
        raise HTTPException(404, "Document parent introuvable")
    if parent.status == "signed":
        raise HTTPException(400, "Document parent déjà signé")
    # The actual parent is the parent's parent if any (single-level grouping)
    actual_parent_id = parent.parent_file_id or parent.id

    child_q = select(FileModel).where(FileModel.id == payload.child_id)
    child_q = _files_filter(child_q, user)
    child = (await db.execute(child_q)).scalar_one_or_none()
    if not child:
        raise HTTPException(404, "Document à lier introuvable")
    if child.id == actual_parent_id:
        raise HTTPException(400, "Impossible de lier un document à lui-même")
    if child.status == "signed":
        raise HTTPException(400, "Document déjà signé — impossible à lier")
    if child.parent_file_id and child.parent_file_id != actual_parent_id:
        raise HTTPException(400, "Ce document est déjà lié à un autre dossier")
    # If the child has its own children, refuse (we keep one-level grouping)
    has_kids = (await db.execute(
        select(func.count()).select_from(FileModel).where(FileModel.parent_file_id == child.id)
    )).scalar_one()
    if has_kids:
        raise HTTPException(400, "Ce document possède déjà ses propres documents liés — détachez-les d'abord")
    # Remove access code from child (it shares the parent's now)
    child.access_code = None
    child.parent_file_id = actual_parent_id
    # Compute sort_order
    existing = (await db.execute(
        select(func.count()).select_from(FileModel).where(FileModel.parent_file_id == actual_parent_id)
    )).scalar_one()
    child.sort_order = existing  # appended last (no +1 because count includes itself if any)
    await db.commit()
    return {"ok": True, "child_id": child.id, "parent_id": actual_parent_id}


@api_router.post("/files/{file_id}/link-attestation")
async def link_attestation_simplifiee(
    file_id: str,
    user=Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Auto-link an Attestation Simplifiée (Cerfa N°13948*05) as child of the given file.
    The attestation template ships with the app and contains preset fields (Nom, Prénom,
    Adresse, Code postal, Commune, Fait à, Le + Signature) on page 1.
    """
    import json as _json
    parent_q = select(FileModel).where(FileModel.id == file_id)
    parent_q = _files_filter(parent_q, user)
    parent = (await db.execute(parent_q)).scalar_one_or_none()
    if not parent:
        raise HTTPException(404, "Document parent introuvable")
    if parent.status == "signed":
        raise HTTPException(400, "Document parent déjà signé")
    actual_parent_id = parent.parent_file_id or parent.id

    # Refuse if an attestation is already linked under this group
    already = (await db.execute(
        select(FileModel).where(
            FileModel.parent_file_id == actual_parent_id,
            FileModel.document_type == "Attestation Simplifiée",
        )
    )).scalar_one_or_none()
    if already:
        raise HTTPException(400, "Une Attestation Simplifiée est déjà liée à ce dossier")

    tpl_path = ROOT_DIR / "templates" / "attestation_simplifiee.pdf"
    if not tpl_path.exists():
        raise HTTPException(500, "Modèle d'attestation introuvable sur le serveur")
    content = tpl_path.read_bytes()
    content_b64 = base64.b64encode(content).decode("utf-8")

    existing_children = (await db.execute(
        select(func.count()).select_from(FileModel).where(FileModel.parent_file_id == actual_parent_id)
    )).scalar_one()

    file_id_new = str(uuid.uuid4())
    new_file = FileModel(
        id=file_id_new,
        filename="attestation_simplifiee.pdf",
        content_b64=content_b64,
        size=len(content),
        status="unsigned",
        access_code=None,
        created_by=user["id"],
        created_by_username=user["username"],
        created_at=datetime.now(timezone.utc).isoformat(),
        signed_at=None,
        signed_content_b64=None,
        signature_position="bottom-center",
        document_type="Attestation Simplifiée",
        parent_file_id=actual_parent_id,
        fields=_json.dumps(_attestation_fields()),
        sort_order=existing_children + 1,
    )
    db.add(new_file)
    await db.commit()
    return file_to_dict(new_file)


# ---------- Document Types (managed by any authenticated user, can be created by gestionnaires too) ----------
@api_router.get("/document-types")
async def list_document_types(user=Depends(get_current_admin), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(DocumentType).order_by(DocumentType.name))).scalars().all()
    out = []
    for t in rows:
        out.append({
            "id": t.id,
            "name": t.name,
            "default_signature_position": t.default_signature_position,
            "created_at": t.created_at,
        })
    return out


@api_router.post("/document-types")
async def create_document_type(payload: DocumentTypeCreate, user=Depends(get_current_admin), db: AsyncSession = Depends(get_db)):
    name = payload.name.strip()
    if not name or len(name) < 2 or len(name) > 50:
        raise HTTPException(400, "Nom invalide (2-50 caractères)")
    pos = payload.default_signature_position or "bottom-right"
    if pos not in VALID_POSITIONS:
        raise HTTPException(400, "Position par défaut invalide")
    existing = (await db.execute(select(DocumentType).where(DocumentType.name == name))).scalar_one_or_none()
    if existing:
        raise HTTPException(400, "Ce type existe déjà")
    t = DocumentType(
        id=str(uuid.uuid4()), name=name,
        default_signature_position=pos,
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    db.add(t)
    await db.commit()
    return {"id": t.id, "name": t.name, "default_signature_position": t.default_signature_position}


@api_router.patch("/document-types/{type_id}")
async def update_document_type_endpoint(type_id: str, payload: DocumentTypeUpdate, user=Depends(get_current_admin), db: AsyncSession = Depends(get_db)):
    t = (await db.execute(select(DocumentType).where(DocumentType.id == type_id))).scalar_one_or_none()
    if not t:
        raise HTTPException(404, "Type introuvable")
    if payload.name is not None:
        new_name = payload.name.strip()
        if len(new_name) < 2 or len(new_name) > 50:
            raise HTTPException(400, "Nom invalide")
        if new_name != t.name:
            clash = (await db.execute(select(DocumentType).where(DocumentType.name == new_name))).scalar_one_or_none()
            if clash:
                raise HTTPException(400, "Ce nom existe déjà")
            await db.execute(
                FileModel.__table__.update().where(FileModel.document_type == t.name).values(document_type=new_name)
            )
            t.name = new_name
    if payload.default_signature_position is not None:
        if payload.default_signature_position not in VALID_POSITIONS:
            raise HTTPException(400, "Position invalide")
        t.default_signature_position = payload.default_signature_position
    await db.commit()
    return {"ok": True}


@api_router.delete("/document-types/{type_id}")
async def delete_document_type(type_id: str, user=Depends(require_super_admin), db: AsyncSession = Depends(get_db)):
    t = (await db.execute(select(DocumentType).where(DocumentType.id == type_id))).scalar_one_or_none()
    if not t:
        raise HTTPException(404, "Type introuvable")
    # Reassign files of this type to "Devis"
    await db.execute(
        FileModel.__table__.update().where(FileModel.document_type == t.name).values(document_type="Devis")
    )
    await db.delete(t)
    await db.commit()
    return {"ok": True}


# ---------- Signer (public) ----------
@api_router.post("/access/verify")
async def verify_code(payload: CodeVerify, db: AsyncSession = Depends(get_db)):
    code = payload.code.strip().upper()
    f = (await db.execute(select(FileModel).where(FileModel.access_code == code))).scalar_one_or_none()
    if not f:
        raise HTTPException(404, "Code d'accès invalide")
    return {"id": f.id, "filename": f.filename, "status": f.status, "access_code": code}


@api_router.get("/access/file/{code}")
async def get_file_by_code(code: str, db: AsyncSession = Depends(get_db)):
    """Returns the parent file + all linked child files (sorted) for a given access code."""
    code = code.strip().upper()
    f = (await db.execute(select(FileModel).where(FileModel.access_code == code))).scalar_one_or_none()
    if not f:
        raise HTTPException(404, "Code d'accès invalide")
    # Build the list: parent first, then children
    children = (await db.execute(
        select(FileModel).where(FileModel.parent_file_id == f.id).order_by(FileModel.sort_order)
    )).scalars().all()
    all_files = [f] + list(children)

    def file_payload(file_obj):
        is_signed = file_obj.status == "signed" and file_obj.signed_content_b64
        content_b64 = file_obj.signed_content_b64 if is_signed else file_obj.content_b64
        d = file_to_dict(file_obj)
        d["content_b64"] = content_b64
        # Use signed_filename for display when applicable
        if is_signed and file_obj.signed_filename:
            d["filename"] = file_obj.signed_filename
        return d

    return {
        "id": f.id,
        "filename": f.filename,
        "status": f.status,
        "documents": [file_payload(x) for x in all_files],
        "all_signed": all(x.status == "signed" for x in all_files),
    }


def _embed_signature_in_pdf(pdf_bytes: bytes, signature_png_bytes: bytes, position: str = "bottom-right") -> bytes:
    return _build_overlay_pdf(pdf_bytes, signature_png_bytes=signature_png_bytes, position=position)


def _draw_text_field(c, x, y, width, value, font_size=10):
    from reportlab.pdfbase.pdfmetrics import stringWidth
    c.setFont("Helvetica", font_size)
    c.setFillColorRGB(0, 0, 0)
    # Truncate if too long
    txt = str(value or "")
    while txt and stringWidth(txt, "Helvetica", font_size) > width:
        txt = txt[:-1]
    c.drawString(x, y, txt)


def _build_overlay_pdf(pdf_bytes: bytes, signature_png_bytes: bytes = None, position: str = "bottom-right",
                       fields: list = None, field_values: dict = None) -> bytes:
    """Build an overlay that embeds the signature image AND draws text fields on relevant pages."""
    import json as _json
    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()
    fields = fields or []
    field_values = field_values or {}
    num_pages = len(reader.pages)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    # Sort fields by page
    fields_by_page = {}
    for fd in fields:
        page_idx = max(0, int(fd.get("page", 1)) - 1)
        fields_by_page.setdefault(page_idx, []).append(fd)

    # Determine on which page to place the signature
    # If a field of type "signature" is provided, use it; otherwise place on last page using `position`
    sig_field = None
    for fd in fields:
        if fd.get("type") == "signature":
            sig_field = fd
            break

    sig_img = None
    if signature_png_bytes:
        sig_img = Image.open(io.BytesIO(signature_png_bytes)).convert("RGBA")

    for i, page in enumerate(reader.pages):
        media = page.mediabox
        width = float(media.width); height = float(media.height)
        overlay_buf = io.BytesIO()
        c = rl_canvas.Canvas(overlay_buf, pagesize=(width, height))
        has_content = False  # track whether anything was drawn

        # Draw text fields on this page
        for fd in fields_by_page.get(i, []):
            if fd.get("type") == "signature":
                continue
            name = fd.get("name")
            value = field_values.get(name, "")
            if fd.get("type") == "date_auto":
                value = datetime.now(timezone.utc).strftime("%d/%m/%Y")
            if value == "" or value is None:
                continue  # skip empty fields, don't dirty the overlay
            x = float(fd.get("x", 100))
            y = float(fd.get("y", 100))
            w = float(fd.get("width", 200))
            _draw_text_field(c, x, y, w, value, font_size=10)
            has_content = True

        # Draw signature
        if sig_img is not None:
            if sig_field is not None and i == max(0, int(sig_field.get("page", 1)) - 1):
                # Use the field's x/y/width/height
                target_w = float(sig_field.get("width", 220))
                sw, sh = sig_img.size
                aspect = sh / sw if sw else 1
                target_h = float(sig_field.get("height", target_w * aspect))
                x = float(sig_field.get("x", width - target_w - 36))
                y = float(sig_field.get("y", 36))
                c.drawImage(ImageReader(sig_img), x, y, width=target_w, height=target_h, mask='auto')
                c.setFont("Helvetica", 8); c.setFillColorRGB(0.4, 0.4, 0.4)
                c.drawString(x, y - 10, f"Signé le {timestamp}")
                has_content = True
            elif sig_field is None and i == num_pages - 1:
                # Fallback: use position (9-pos system) on last page
                sw, sh = sig_img.size
                target_w = min(220.0, width * 0.4)
                aspect = sh / sw if sw else 1
                target_h = target_w * aspect
                pos = position or "bottom-right"
                parts = pos.split("-") if "-" in pos else ["bottom", "right"]
                v_pos = parts[0] if len(parts) > 0 else "bottom"
                h_pos = parts[1] if len(parts) > 1 else "right"
                margin = 36.0
                if h_pos == "left": x = margin
                elif h_pos == "center": x = (width - target_w) / 2
                else: x = width - target_w - margin
                if v_pos == "top": y = height - target_h - margin
                elif v_pos == "middle": y = (height - target_h) / 2
                else: y = margin
                c.drawImage(ImageReader(sig_img), x, y, width=target_w, height=target_h, mask='auto')
                c.setFont("Helvetica", 8); c.setFillColorRGB(0.4, 0.4, 0.4)
                label_y = y - 10 if v_pos != "top" else y + target_h + 4
                c.drawString(x, label_y, f"Signé le {timestamp}")
                has_content = True

        if has_content:
            # Force a page emission and save → guarantees overlay has at least 1 page
            c.showPage()
            c.save()
            overlay_reader = PdfReader(io.BytesIO(overlay_buf.getvalue()))
            if len(overlay_reader.pages) > 0:
                page.merge_page(overlay_reader.pages[0])
        writer.add_page(page)

    out = io.BytesIO(); writer.write(out)
    return out.getvalue()


@api_router.post("/access/sign/{code}")
async def sign_files(code: str, payload: SignFullInput, db: AsyncSession = Depends(get_db)):
    """Sign all files linked to this code in one transaction."""
    import json as _json
    code = code.strip().upper()
    parent = (await db.execute(select(FileModel).where(FileModel.access_code == code))).scalar_one_or_none()
    if not parent:
        raise HTTPException(404, "Code d'accès invalide")

    children = (await db.execute(
        select(FileModel).where(FileModel.parent_file_id == parent.id).order_by(FileModel.sort_order)
    )).scalars().all()
    all_files = [parent] + list(children)

    if all(x.status == "signed" for x in all_files):
        raise HTTPException(400, "Tous les documents ont déjà été signés")

    # Parse signature image (if provided)
    sig_bytes = None
    if payload.signature_data_url:
        if "," not in payload.signature_data_url:
            raise HTTPException(400, "Signature invalide")
        _, b64 = payload.signature_data_url.split(",", 1)
        try:
            sig_bytes = base64.b64decode(b64)
        except Exception:
            raise HTTPException(400, "Signature invalide")

    # Inject fait_a into field_values dict for convenience
    field_values = dict(payload.field_values or {})
    if payload.fait_a and "fait_a" not in field_values:
        field_values["fait_a"] = payload.fait_a

    now = datetime.now(timezone.utc).isoformat()
    # Compute parent base name once (used to build "{parent}+{child}.pdf" for children)
    parent_base = os.path.splitext(parent.filename or "document")[0]
    for f in all_files:
        if f.status == "signed":
            continue
        try:
            fields_list = _json.loads(f.fields) if f.fields else []
        except Exception:
            fields_list = []
        pdf_bytes = base64.b64decode(f.content_b64)
        try:
            signed_pdf = _build_overlay_pdf(
                pdf_bytes, signature_png_bytes=sig_bytes,
                position=f.signature_position or "bottom-right",
                fields=fields_list, field_values=field_values,
            )
        except Exception as e:
            logger.exception(f"Erreur signature {f.id}")
            raise HTTPException(500, f"Erreur lors de la signature: {e}")
        f.signed_content_b64 = base64.b64encode(signed_pdf).decode("utf-8")
        f.status = "signed"
        f.signed_at = now
        # Build signed_filename: for child docs use "{parent_base}+{child_base}.pdf"
        if f.id != parent.id and f.parent_file_id:
            child_base = os.path.splitext(f.filename or "doc")[0]
            f.signed_filename = f"{parent_base}+{child_base}.pdf"

    await db.commit()
    return {"ok": True, "status": "signed", "signed_at": now, "documents_signed": len(all_files)}


# ---------- Health ----------
@api_router.get("/")
async def root():
    return {"message": "Devis Signature API", "ok": True}


# ---------- PDF.js worker (served from backend to avoid manual deploy step) ----------
_WORKER_CANDIDATES = [
    ROOT_DIR.parent / "frontend" / "public" / "pdf.worker.min.mjs",
    ROOT_DIR.parent / "frontend" / "node_modules" / "pdfjs-dist" / "build" / "pdf.worker.min.mjs",
    ROOT_DIR.parent / "frontend" / "build" / "pdf.worker.min.mjs",
    ROOT_DIR / "static" / "pdf.worker.min.mjs",
]


def _find_pdf_worker() -> Optional[Path]:
    for p in _WORKER_CANDIDATES:
        if p.exists() and p.is_file():
            return p
    return None


@api_router.get("/pdf-worker.mjs")
async def pdf_worker():
    """Serve the pdfjs worker bundled with the app — guarantees same-origin availability
    regardless of how the frontend is deployed on Debian / Nginx / etc."""
    p = _find_pdf_worker()
    if not p:
        raise HTTPException(404, "PDF.js worker not found on server")
    return FileResponse(
        p,
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ---------- User Management ----------
@api_router.get("/users")
async def list_users(user=Depends(require_super_admin), db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(User).where(User.role != "super_admin").order_by(User.created_at.desc())
    )
    users = result.scalars().all()
    out = []
    for u in users:
        d = user_to_dict(u)
        # files count
        cnt = (await db.execute(
            select(func.count()).select_from(FileModel).where(FileModel.created_by == u.id)
        )).scalar_one()
        d["files_count"] = cnt
        out.append(d)
    return out


@api_router.post("/users")
async def create_user(payload: UserCreate, user=Depends(require_super_admin), db: AsyncSession = Depends(get_db)):
    username = payload.username.strip().lower()
    if not username or len(username) < 3:
        raise HTTPException(400, "Nom d'utilisateur trop court (min 3 caractères)")
    if not payload.password or len(payload.password) < 6:
        raise HTTPException(400, "Mot de passe trop court (min 6 caractères)")
    existing = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if existing:
        raise HTTPException(400, "Ce nom d'utilisateur existe déjà")
    new_id = str(uuid.uuid4())
    new_user = User(
        id=new_id, username=username,
        password_hash=hash_password(payload.password),
        role="gestionnaire",
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    db.add(new_user)
    await db.commit()
    return {"id": new_id, "username": username, "role": "gestionnaire"}


@api_router.patch("/users/{user_id}")
async def update_user(user_id: str, payload: UserUpdate, user=Depends(require_super_admin), db: AsyncSession = Depends(get_db)):
    target = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    if target.role == "super_admin":
        raise HTTPException(403, "Impossible de modifier un super admin")

    if payload.username is not None:
        new_username = payload.username.strip().lower()
        if len(new_username) < 3:
            raise HTTPException(400, "Nom d'utilisateur trop court")
        if new_username != target.username:
            clash = (await db.execute(select(User).where(User.username == new_username))).scalar_one_or_none()
            if clash:
                raise HTTPException(400, "Ce nom d'utilisateur existe déjà")
            old_username = target.username
            target.username = new_username
            # propagate to files
            files_to_update = (await db.execute(
                select(FileModel).where(FileModel.created_by == user_id)
            )).scalars().all()
            for f in files_to_update:
                f.created_by_username = new_username
    if payload.password is not None and payload.password != "":
        if len(payload.password) < 6:
            raise HTTPException(400, "Mot de passe trop court (min 6 caractères)")
        target.password_hash = hash_password(payload.password)
    await db.commit()
    return {"ok": True, "updated": True}


@api_router.delete("/users/{user_id}")
async def delete_user(user_id: str, user=Depends(require_super_admin), db: AsyncSession = Depends(get_db)):
    target = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    if target.role == "super_admin":
        raise HTTPException(403, "Impossible de supprimer un super admin")
    if target.id == user["id"]:
        raise HTTPException(400, "Impossible de se supprimer soi-même")
    await db.execute(delete(FileModel).where(FileModel.created_by == user_id))
    await db.delete(target)
    await db.commit()
    return {"ok": True}


# ---------- Database Explorer (super_admin only) ----------
ALLOWED_TABLES = {"users", "files"}


@api_router.get("/admin/db/tables")
async def db_list_tables(user=Depends(require_super_admin), db: AsyncSession = Depends(get_db)):
    """List app tables with row counts."""
    out = []
    for name in ALLOWED_TABLES:
        model = User if name == "users" else FileModel
        cnt = (await db.execute(select(func.count()).select_from(model))).scalar_one()
        out.append({"name": name, "row_count": cnt})
    return out


@api_router.get("/admin/db/table/{table_name}")
async def db_browse_table(
    table_name: str,
    limit: int = 50,
    offset: int = 0,
    user=Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
):
    """Browse table rows (read-only). Sensitive columns are masked."""
    if table_name not in ALLOWED_TABLES:
        raise HTTPException(400, "Table inconnue")
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    if table_name == "users":
        rows = (await db.execute(
            select(User).order_by(User.created_at.desc()).offset(offset).limit(limit)
        )).scalars().all()
        total = (await db.execute(select(func.count()).select_from(User))).scalar_one()
        columns = ["id", "username", "role", "password_hash", "created_at"]
        data = []
        for u in rows:
            data.append({
                "id": u.id,
                "username": u.username,
                "role": u.role,
                "password_hash": (u.password_hash[:10] + "…[masqué]") if u.password_hash else "",
                "created_at": u.created_at,
            })
        return {"table": table_name, "columns": columns, "rows": data, "total": total, "limit": limit, "offset": offset}

    # files
    rows = (await db.execute(
        select(FileModel).order_by(FileModel.created_at.desc()).offset(offset).limit(limit)
    )).scalars().all()
    total = (await db.execute(select(func.count()).select_from(FileModel))).scalar_one()
    columns = ["id", "filename", "size", "status", "access_code", "created_by_username",
               "created_at", "signed_at", "signature_position", "content_b64"]
    data = []
    for f in rows:
        data.append({
            "id": f.id,
            "filename": f.filename,
            "size": f.size,
            "status": f.status,
            "access_code": f.access_code,
            "created_by_username": f.created_by_username,
            "created_at": f.created_at,
            "signed_at": f.signed_at,
            "signature_position": f.signature_position,
            "content_b64": f"[{len(f.content_b64) if f.content_b64 else 0} chars]",
        })
    return {"table": table_name, "columns": columns, "rows": data, "total": total, "limit": limit, "offset": offset}


# ---------- Startup ----------
@app.on_event("startup")
async def on_startup():
    await init_db()

    async with AsyncSessionLocal() as session:
        # Seed default document types if none exists
        existing_types = (await session.execute(select(DocumentType))).scalars().all()
        existing_type_names = {t.name for t in existing_types}
        if not existing_types:
            defaults = [
                ("Devis", "bottom-right"),
                ("Attestation", "bottom-center"),
                ("Attestation Simplifiée", "bottom-center"),
                ("Contrat", "bottom-right"),
                ("Bon de commande", "bottom-right"),
            ]
            for name, pos in defaults:
                session.add(DocumentType(
                    id=str(uuid.uuid4()),
                    name=name,
                    default_signature_position=pos,
                    created_at=datetime.now(timezone.utc).isoformat(),
                ))
            await session.commit()
            logger.info(f"[seed] Created {len(defaults)} default document types")
        elif "Attestation Simplifiée" not in existing_type_names:
            # Upsert the new type when upgrading from older versions
            session.add(DocumentType(
                id=str(uuid.uuid4()),
                name="Attestation Simplifiée",
                default_signature_position="bottom-center",
                created_at=datetime.now(timezone.utc).isoformat(),
            ))
            await session.commit()
            logger.info("[seed] Added 'Attestation Simplifiée' document type")

        # Migration: refresh field coordinates on existing unsigned Attestation Simplifiée files
        # (fixes the v1 wrong-x-positions bug; only touches files still in 'unsigned' state)
        import json as _json
        unsigned_atts = (await session.execute(
            select(FileModel).where(
                FileModel.document_type == "Attestation Simplifiée",
                FileModel.status == "unsigned",
            )
        )).scalars().all()
        new_preset_json = _json.dumps(_attestation_fields())
        refreshed = 0
        for att in unsigned_atts:
            if att.fields != new_preset_json:
                att.fields = new_preset_json
                refreshed += 1
        if refreshed:
            await session.commit()
            logger.info(f"[migration] Refreshed Attestation Simplifiée field coords on {refreshed} unsigned files")

        # Step 1 — Sync the super_admin entry (always identified by role, not username)
        super_in_config = next((e for e in USERS if e.get("role") == "super_admin"), None)
        if super_in_config:
            cfg_username = super_in_config.get("username", "").strip().lower()
            cfg_password = super_in_config.get("password", "")
            existing_super = (await session.execute(
                select(User).where(User.role == "super_admin")
            )).scalar_one_or_none()

            if existing_super is None:
                session.add(User(
                    id=str(uuid.uuid4()),
                    username=cfg_username,
                    password_hash=hash_password(cfg_password),
                    role="super_admin",
                    created_at=datetime.now(timezone.utc).isoformat(),
                ))
                logger.info(f"[config] Created super_admin: {cfg_username}")
            else:
                # Rename if needed (handles config.py changes)
                if existing_super.username != cfg_username:
                    # Make sure new username isn't already used by another user
                    clash = (await session.execute(
                        select(User).where(User.username == cfg_username, User.id != existing_super.id)
                    )).scalar_one_or_none()
                    if clash:
                        logger.warning(
                            f"[config] Cannot rename super_admin to '{cfg_username}': name already used. "
                            f"Remove or rename the conflicting user first."
                        )
                    else:
                        old = existing_super.username
                        existing_super.username = cfg_username
                        logger.info(f"[config] Renamed super_admin: {old} → {cfg_username}")
                # Sync password
                if SYNC_PASSWORDS and not verify_password(cfg_password, existing_super.password_hash):
                    existing_super.password_hash = hash_password(cfg_password)
                    logger.info(f"[config] Updated super_admin password")

        # Step 2 — Sync gestionnaire entries by username
        config_usernames = set()
        if super_in_config:
            config_usernames.add(super_in_config.get("username", "").strip().lower())

        for entry in USERS:
            if entry.get("role") == "super_admin":
                continue  # already handled above
            username = entry.get("username", "").strip().lower()
            password = entry.get("password", "")
            role = entry.get("role", "gestionnaire")
            if not username or not password:
                logger.warning(f"Skipping invalid user entry: {entry}")
                continue
            if role not in ROLES:
                logger.warning(f"Unknown role '{role}' for '{username}'")
                continue
            config_usernames.add(username)
            existing = (await session.execute(select(User).where(User.username == username))).scalar_one_or_none()
            if existing is None:
                session.add(User(
                    id=str(uuid.uuid4()),
                    username=username,
                    password_hash=hash_password(password),
                    role=role,
                    created_at=datetime.now(timezone.utc).isoformat(),
                ))
                logger.info(f"[config] Created user: {username} ({role})")
            else:
                if existing.role != role:
                    existing.role = role
                if SYNC_PASSWORDS and not verify_password(password, existing.password_hash):
                    existing.password_hash = hash_password(password)
                    logger.info(f"[config] Updated user: {username}")

        if SYNC_DELETE_MISSING:
            all_users = (await session.execute(select(User))).scalars().all()
            for u in all_users:
                if u.username not in config_usernames:
                    await session.execute(delete(FileModel).where(FileModel.created_by == u.id))
                    await session.delete(u)
                    logger.info(f"[config] Removed user not in config: {u.username}")

        await session.commit()


# ---------- Mount ----------
app.include_router(api_router)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)
