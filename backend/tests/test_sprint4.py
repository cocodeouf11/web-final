"""Sprint 4 backend tests:
- PATCH /api/files/{id}/rename
  * 200 with {ok, filename, previous}
  * auto-appends .pdf if missing
  * strips whitespace
  * 400 on empty
  * 404 on non-existent
  * parent rename refreshes children's signed_filename combined pattern
"""
import io
import os
import base64
import pytest
import requests
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.lib.pagesizes import A4

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"
ADMIN = {"username": "admin", "password": "admin123"}

SIG_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII="
)
SIG_DATA_URL = f"data:image/png;base64,{SIG_PNG}"


def _pdf(npages: int = 1) -> bytes:
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=A4)
    for i in range(npages):
        c.drawString(72, 770, f"Page {i+1}")
        c.showPage()
    c.save()
    return buf.getvalue()


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    r = s.post(f"{API}/auth/login", json=ADMIN)
    assert r.status_code == 200, r.text
    return s


@pytest.fixture
def uploaded_file(session):
    pdf = _pdf(1)
    r = session.post(
        f"{API}/files/upload",
        files={"file": ("TEST_rename_original.pdf", pdf, "application/pdf")},
        data={"document_type": "Devis"},
    )
    assert r.status_code == 200
    fid = r.json()["id"]
    yield fid
    session.delete(f"{API}/files/{fid}")


# ---------- Basic rename behavior ----------
def test_rename_simple(session, uploaded_file):
    r = session.patch(f"{API}/files/{uploaded_file}/rename", json={"filename": "TEST_renamed_new.pdf"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["filename"] == "TEST_renamed_new.pdf"
    assert body["previous"] == "TEST_rename_original.pdf"
    # Verify persistence via GET /api/files
    files = session.get(f"{API}/files").json()
    found = next(x for x in files if x["id"] == uploaded_file)
    assert found["filename"] == "TEST_renamed_new.pdf"


def test_rename_auto_appends_pdf(session, uploaded_file):
    r = session.patch(f"{API}/files/{uploaded_file}/rename", json={"filename": "TEST_no_ext"})
    assert r.status_code == 200, r.text
    assert r.json()["filename"] == "TEST_no_ext.pdf"


def test_rename_strips_whitespace(session, uploaded_file):
    r = session.patch(f"{API}/files/{uploaded_file}/rename", json={"filename": "  TEST_spaced.pdf  "})
    assert r.status_code == 200
    assert r.json()["filename"] == "TEST_spaced.pdf"


def test_rename_empty_returns_400(session, uploaded_file):
    r = session.patch(f"{API}/files/{uploaded_file}/rename", json={"filename": "   "})
    assert r.status_code == 400


def test_rename_nonexistent_returns_404(session):
    r = session.patch(f"{API}/files/no-such-id-zzz/rename", json={"filename": "X.pdf"})
    assert r.status_code == 404


def test_rename_too_long_returns_400(session, uploaded_file):
    long_name = "T" * 260 + ".pdf"
    r = session.patch(f"{API}/files/{uploaded_file}/rename", json={"filename": long_name})
    assert r.status_code == 400


# ---------- Parent rename refreshes children's signed_filename ----------
def test_rename_parent_refreshes_children_signed_filename(session):
    # 1) Create parent
    pdf_p = _pdf(1)
    p = session.post(
        f"{API}/files/upload",
        files={"file": ("TEST_parent_orig.pdf", pdf_p, "application/pdf")},
        data={"document_type": "Devis"},
    ).json()
    pid = p["id"]
    # 2) Generate code + link attestation
    code = session.post(f"{API}/files/{pid}/generate-code").json()["access_code"]
    r = session.post(f"{API}/files/{pid}/link-attestation")
    assert r.status_code == 200
    cid = r.json()["id"]

    # 3) Sign with required fields → child gets signed_filename = "TEST_parent_orig+attestation_simplifiee.pdf"
    payload = {
        "signature_data_url": SIG_DATA_URL,
        "field_values": {
            "nom": "Dupont", "prenom": "Jean", "adresse": "1 rue X",
            "code_postal": "75001", "commune": "Paris", "fait_a": "Paris",
        },
    }
    r = requests.post(f"{API}/access/sign/{code}", json=payload)
    assert r.status_code == 200, r.text

    files = session.get(f"{API}/files").json()
    child = next(x for x in files if x["id"] == cid)
    assert child["signed_filename"] == "TEST_parent_orig+attestation_simplifiee.pdf"

    # 4) Rename PARENT → child signed_filename should update with new parent base
    r = session.patch(f"{API}/files/{pid}/rename", json={"filename": "TEST_parent_renamed.pdf"})
    assert r.status_code == 200, r.text

    files = session.get(f"{API}/files").json()
    child2 = next(x for x in files if x["id"] == cid)
    assert child2["signed_filename"] == "TEST_parent_renamed+attestation_simplifiee.pdf", \
        f"got {child2['signed_filename']!r}"

    # 5) Rename CHILD → its signed_filename should rebuild with current parent base
    r = session.patch(f"{API}/files/{cid}/rename", json={"filename": "TEST_attest_new.pdf"})
    assert r.status_code == 200, r.text
    files = session.get(f"{API}/files").json()
    child3 = next(x for x in files if x["id"] == cid)
    assert child3["signed_filename"] == "TEST_parent_renamed+TEST_attest_new.pdf", \
        f"got {child3['signed_filename']!r}"

    # cleanup
    session.delete(f"{API}/files/{cid}")
    session.delete(f"{API}/files/{pid}")


def test_rename_unsigned_child_does_not_create_signed_filename(session):
    """Renaming a child that has no signed_filename should NOT create one."""
    pdf_p = _pdf(1)
    pid = session.post(
        f"{API}/files/upload",
        files={"file": ("TEST_par_us.pdf", pdf_p, "application/pdf")},
        data={"document_type": "Devis"},
    ).json()["id"]
    session.post(f"{API}/files/{pid}/generate-code")
    cid = session.post(f"{API}/files/{pid}/link-attestation").json()["id"]
    # Rename unsigned child
    r = session.patch(f"{API}/files/{cid}/rename", json={"filename": "TEST_child_new.pdf"})
    assert r.status_code == 200
    files = session.get(f"{API}/files").json()
    child = next(x for x in files if x["id"] == cid)
    assert child["filename"] == "TEST_child_new.pdf"
    assert not child.get("signed_filename"), f"unexpected signed_filename: {child.get('signed_filename')!r}"
    session.delete(f"{API}/files/{cid}")
    session.delete(f"{API}/files/{pid}")
