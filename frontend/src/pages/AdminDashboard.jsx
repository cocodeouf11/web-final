import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from "../components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "../components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from "../components/ui/dropdown-menu";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "../components/ui/table";
import {
  FileText, Upload, Trash2, Eye, KeyRound, MoreHorizontal, LogOut, Search, Copy,
  CheckCircle2, Clock, FileSignature, Filter, Users, ShieldCheck, FolderKanban, MoveDiagonal,
  Database, ArrowDownUp, Link2, Tag, Settings, Plus, X, Paperclip, Move, FileCheck2, Files, Pencil, Folder, FolderOpen, ChevronDown, ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import api, { formatApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { base64ToBlobUrl, revokeBlobUrl } from "../lib/pdf";
import ManagersPanel from "./ManagersPanel";
import DatabaseExplorer from "./DatabaseExplorer";
import MyAccountDialog from "./MyAccountDialog";
import ThemeToggle from "../components/ThemeToggle";
import PdfViewer from "../components/PdfViewer";
import SignaturePositionPicker, { positionLabel } from "../components/SignaturePositionPicker";
import SignaturePositionEditor from "../components/SignaturePositionEditor";

function StatusBadge({ status }) {
  if (status === "signed") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-medium border border-emerald-500/30" data-testid="status-badge-signed">
        <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={1.8} /> Signé
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs font-medium border border-amber-500/30" data-testid="status-badge-unsigned">
      <Clock className="w-3.5 h-3.5" strokeWidth={1.8} /> Non signé
    </span>
  );
}

const formatDate = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return "—"; }
};
const formatDateTime = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) +
           " · " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
};

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("created_desc");  // created_desc | created_asc | signed_desc | signed_asc
  const [search, setSearch] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewFile, setPreviewFile] = useState(null);
  const [positionFile, setPositionFile] = useState(null);
  const [positionValue, setPositionValue] = useState("bottom-right");
  const [typeFile, setTypeFile] = useState(null);  // file whose type is being edited
  const [typeValue, setTypeValue] = useState("Devis");
  const [uploadType, setUploadType] = useState("Devis");
  const [documentTypes, setDocumentTypes] = useState([]);
  const [typesManagerOpen, setTypesManagerOpen] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");
  const [newTypePos, setNewTypePos] = useState("bottom-right");
  const [linkParent, setLinkParent] = useState(null);  // file to link a new doc to
  const [linkType, setLinkType] = useState("Devis");
  const [linkUploading, setLinkUploading] = useState(false);
  const [linkMode, setLinkMode] = useState("upload");  // 'upload' | 'existing'
  const [linkExistingChild, setLinkExistingChild] = useState("");
  const [customPosFile, setCustomPosFile] = useState(null);  // file for free drag&drop signature placement
  const [renameFile, setRenameFile] = useState(null);  // file being renamed
  const [renameValue, setRenameValue] = useState("");
  const [expanded, setExpanded] = useState({});  // {parentId: true} for folder expansion
  const linkFileRef = useRef(null);
  const fileInputRef = useRef(null);

  const loadFiles = async () => {
    try {
      const { data } = await api.get("/files");
      setFiles(data);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Erreur de chargement");
    } finally {
      setLoading(false);
    }
  };

  const loadDocumentTypes = async () => {
    try {
      const { data } = await api.get("/document-types");
      setDocumentTypes(data);
    } catch { /* silent */ }
  };

  useEffect(() => { loadFiles(); loadDocumentTypes(); }, []);

  // cleanup blob URL on dialog close
  useEffect(() => {
    return () => { if (previewFile?.blobUrl) revokeBlobUrl(previewFile.blobUrl); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFile?.blobUrl]);

  // Group files into "folders": each parent (no parent_file_id) carries its children.
  // Children are filtered out from the top-level list.
  const childrenByParent = useMemo(() => {
    const map = {};
    for (const f of files) {
      if (f.parent_file_id) {
        (map[f.parent_file_id] = map[f.parent_file_id] || []).push(f);
      }
    }
    // Sort children by sort_order
    Object.values(map).forEach((arr) => arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)));
    return map;
  }, [files]);

  const stats = useMemo(() => {
    // Count parents only (children belong to a folder)
    const parents = files.filter((f) => !f.parent_file_id);
    return {
      total: parents.length,
      signed: parents.filter((f) => {
        const kids = childrenByParent[f.id] || [];
        const all = [f, ...kids];
        return all.every((x) => x.status === "signed");
      }).length,
      unsigned: parents.filter((f) => {
        const kids = childrenByParent[f.id] || [];
        const all = [f, ...kids];
        return !all.every((x) => x.status === "signed");
      }).length,
    };
  }, [files, childrenByParent]);

  const filtered = useMemo(() => {
    // Top-level parents only
    let list = files.filter((f) => !f.parent_file_id);
    // For the folder status (signed/unsigned), aggregate over children too
    const folderStatus = (f) => {
      const kids = childrenByParent[f.id] || [];
      const all = [f, ...kids];
      return all.every((x) => x.status === "signed") ? "signed" : "unsigned";
    };
    if (filter === "signed") list = list.filter((f) => folderStatus(f) === "signed");
    if (filter === "unsigned") list = list.filter((f) => folderStatus(f) === "unsigned");
    if (search.trim()) {
      const s = search.toLowerCase();
      list = list.filter((f) => {
        const kids = childrenByParent[f.id] || [];
        const all = [f, ...kids];
        return all.some((x) =>
          x.filename.toLowerCase().includes(s) ||
          (f.access_code || "").toLowerCase().includes(s)
        );
      });
    }
    const cmp = (a, b, key) => {
      const va = a[key] || "";
      const vb = b[key] || "";
      if (!va && vb) return 1;
      if (va && !vb) return -1;
      if (va < vb) return -1;
      if (va > vb) return 1;
      return 0;
    };
    if (sortBy === "created_desc") list.sort((a, b) => cmp(b, a, "created_at"));
    else if (sortBy === "created_asc") list.sort((a, b) => cmp(a, b, "created_at"));
    else if (sortBy === "signed_desc") list.sort((a, b) => cmp(b, a, "signed_at"));
    else if (sortBy === "signed_asc") list.sort((a, b) => cmp(a, b, "signed_at"));
    return list;
  }, [files, filter, search, sortBy, childrenByParent]);

  const sortLabel = {
    created_desc: "Plus récent",
    created_asc: "Plus ancien",
    signed_desc: "Signés (récent)",
    signed_asc: "Signés (ancien)",
  }[sortBy];

  const handleUpload = async (e) => {
    e.preventDefault();
    const f = fileInputRef.current?.files?.[0];
    if (!f) {
      toast.error("Sélectionnez un fichier PDF");
      return;
    }
    if (!f.name.toLowerCase().endsWith(".pdf")) {
      toast.error("Seuls les PDF sont acceptés");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("document_type", uploadType);
      await api.post("/files/upload", fd, { headers: { "Content-Type": "multipart/form-data" } });
      toast.success("Fichier ajouté avec succès", { description: `${f.name} · ${uploadType}` });
      if (fileInputRef.current) fileInputRef.current.value = "";
      setUploadOpen(false);
      setUploadType("Devis");
      await loadFiles();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Erreur lors de l'upload");
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/files/${id}`);
      toast.success("Fichier supprimé");
      await loadFiles();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Erreur");
    }
  };

  const handleGenerateCode = async (id) => {
    try {
      const { data } = await api.post(`/files/${id}/generate-code`);
      await loadFiles();
      navigator.clipboard?.writeText(data.access_code).catch(() => {});
      toast.success(`Code généré : ${data.access_code}`, { description: "Copié dans le presse-papier" });
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Erreur");
    }
  };

  const handleToggleStatus = async (file) => {
    const next = file.status === "signed" ? "unsigned" : "signed";
    try {
      await api.patch(`/files/${file.id}/status`, { status: next });
      toast.success(`Statut modifié : ${next === "signed" ? "Signé" : "Non signé"}`);
      await loadFiles();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Erreur");
    }
  };

  const handlePreview = async (file) => {
    try {
      const { data } = await api.get(`/files/${file.id}/download`, { params: { signed: file.status === "signed" } });
      const blobUrl = base64ToBlobUrl(data.content_b64);
      if (!blobUrl) {
        toast.error("Impossible de prévisualiser le PDF");
        return;
      }
      setPreviewFile({ filename: data.filename, blobUrl });
    } catch (e) {
      toast.error("Impossible d'ouvrir le fichier");
    }
  };

  const openPosition = (file) => {
    if (file.status === "signed") {
      toast.error("Le document est déjà signé — position non modifiable");
      return;
    }
    setPositionFile(file);
    setPositionValue(file.signature_position || "bottom-right");
  };

  const savePosition = async () => {
    if (!positionFile) return;
    try {
      await api.patch(`/files/${positionFile.id}/signature-position`, { signature_position: positionValue });
      toast.success(`Position définie : ${positionLabel(positionValue)}`);
      setPositionFile(null);
      await loadFiles();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Erreur");
    }
  };

  const openTypeEdit = (file) => {
    setTypeFile(file);
    setTypeValue(file.document_type || "Devis");
  };

  const saveType = async () => {
    if (!typeFile) return;
    try {
      await api.patch(`/files/${typeFile.id}/document-type`, { document_type: typeValue });
      toast.success(`Type modifié : ${typeValue}`);
      setTypeFile(null);
      await loadFiles();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Erreur");
    }
  };

  const createType = async (e) => {
    e?.preventDefault?.();
    if (!newTypeName.trim()) return;
    try {
      await api.post("/document-types", {
        name: newTypeName.trim(),
        default_signature_position: newTypePos,
      });
      toast.success(`Type créé : ${newTypeName.trim()}`);
      setNewTypeName(""); setNewTypePos("bottom-right");
      await loadDocumentTypes();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Erreur");
    }
  };

  const deleteType = async (id, name) => {
    try {
      await api.delete(`/document-types/${id}`);
      toast.success(`Type supprimé : ${name}`);
      await loadDocumentTypes();
      await loadFiles();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Erreur");
    }
  };

  const copyDirectLink = (file) => {
    if (!file.access_code) {
      toast.error("Générez d'abord un code d'accès");
      return;
    }
    const link = `${window.location.origin}/sign/${encodeURIComponent(file.access_code)}`;
    navigator.clipboard?.writeText(link).catch(() => {});
    toast.success("Lien direct copié", { description: link, duration: 6000 });
  };

  const handleLinkUpload = async (e) => {
    e.preventDefault();
    if (!linkParent) return;
    if (linkMode === "existing") {
      if (!linkExistingChild) { toast.error("Sélectionnez un document existant"); return; }
      setLinkUploading(true);
      try {
        await api.post(`/files/${linkParent.id}/link-existing`, { child_id: linkExistingChild });
        toast.success("Document lié au dossier");
        setLinkParent(null); setLinkExistingChild(""); setLinkMode("upload");
        await loadFiles();
      } catch (err) {
        toast.error(formatApiError(err.response?.data?.detail) || "Erreur");
      } finally {
        setLinkUploading(false);
      }
      return;
    }
    const f = linkFileRef.current?.files?.[0];
    if (!f) { toast.error("Sélectionnez un PDF"); return; }
    if (!f.name.toLowerCase().endsWith(".pdf")) { toast.error("PDF uniquement"); return; }
    setLinkUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("document_type", linkType);
      fd.append("parent_id", linkParent.id);
      await api.post("/files/upload", fd, { headers: { "Content-Type": "multipart/form-data" } });
      toast.success(`Document lié : ${f.name}`, { description: `Type : ${linkType} · partagera le code de ${linkParent.filename}` });
      if (linkFileRef.current) linkFileRef.current.value = "";
      setLinkParent(null);
      setLinkType("Devis");
      await loadFiles();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Erreur");
    } finally {
      setLinkUploading(false);
    }
  };

  const handleLinkAttestation = async (file) => {
    try {
      await api.post(`/files/${file.id}/link-attestation`);
      toast.success("Attestation Simplifiée liée", {
        description: "Les champs Nom, Prénom, Adresse, Code postal, Commune, Fait à et la signature seront remplis lors de la signature.",
        duration: 6000,
      });
      setExpanded((p) => ({ ...p, [file.id]: true }));  // auto-expand the folder
      await loadFiles();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Erreur");
    }
  };

  const openRename = (file) => {
    setRenameFile(file);
    setRenameValue((file.filename || "").replace(/\.pdf$/i, ""));
  };

  const saveRename = async () => {
    if (!renameFile) return;
    const newName = renameValue.trim();
    if (!newName) {
      toast.error("Nom invalide");
      return;
    }
    try {
      await api.patch(`/files/${renameFile.id}/rename`, { filename: newName });
      toast.success(`Renommé : ${newName}.pdf`);
      setRenameFile(null);
      setRenameValue("");
      await loadFiles();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Erreur");
    }
  };

  const toggleExpand = (id) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  const copyCode = (code) => {
    navigator.clipboard?.writeText(code).catch(() => {});
    toast.success("Code copié");
  };

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-30 glass">
        <div className="max-w-7xl mx-auto px-6 sm:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand flex items-center justify-center">
              <FileText className="w-4 h-4 text-white" strokeWidth={1.8} />
            </div>
            <Badge variant="secondary" className="font-normal" data-testid="role-badge">
              {user?.role === "super_admin" ? (
                <span className="inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> Super admin</span>
              ) : "Gestionnaire"}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="text-sm" data-testid="header-user-menu">
                  {user?.username}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <MyAccountDialog
                  trigger={
                    <DropdownMenuItem onSelect={(e) => e.preventDefault()} data-testid="menu-my-account">
                      Mon compte
                    </DropdownMenuItem>
                  }
                />
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} data-testid="menu-logout">
                  <LogOut className="w-4 h-4 mr-2" /> Déconnexion
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 sm:px-8 py-10">
        <div className="mb-10 fade-in">
          <h1 className="font-display text-4xl sm:text-5xl tracking-tight font-medium text-foreground">
            Tableau de bord
          </h1>
          <p className="text-muted-foreground mt-2 text-base">
            {user?.role === "super_admin"
              ? "Vue globale : gérez tous les devis et les comptes gestionnaires."
              : "Gérez vos devis, générez des codes d'accès et suivez les signatures."}
          </p>
        </div>

        <Tabs defaultValue="files" className="w-full">
          {user?.role === "super_admin" && (
            <TabsList className="bg-muted p-1 rounded-xl h-11 mb-6" data-testid="admin-tabs">
              <TabsTrigger value="files" className="rounded-lg data-[state=active]:bg-card data-[state=active]:shadow-sm" data-testid="tab-files">
                <FolderKanban className="w-4 h-4 mr-2" strokeWidth={1.6} /> Devis
              </TabsTrigger>
              <TabsTrigger value="managers" className="rounded-lg data-[state=active]:bg-card data-[state=active]:shadow-sm" data-testid="tab-managers">
                <Users className="w-4 h-4 mr-2" strokeWidth={1.6} /> Gestionnaires
              </TabsTrigger>
              <TabsTrigger value="database" className="rounded-lg data-[state=active]:bg-card data-[state=active]:shadow-sm" data-testid="tab-database">
                <Database className="w-4 h-4 mr-2" strokeWidth={1.6} /> Base de données
              </TabsTrigger>
            </TabsList>
          )}

          <TabsContent value="files" className="mt-0">
            {/* Stats */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-10">
              {[
                { label: "Total", value: stats.total, icon: FileText, color: "text-foreground", bg: "bg-muted" },
                { label: "Signés", value: stats.signed, icon: CheckCircle2, color: "text-emerald-500", bg: "bg-emerald-500/10" },
                { label: "Non signés", value: stats.unsigned, icon: Clock, color: "text-amber-500", bg: "bg-amber-500/10" },
              ].map((s) => (
                <div key={s.label} className="bg-card border border-border rounded-2xl p-6 lift" data-testid={`stat-${s.label.toLowerCase()}`}>
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-xs uppercase tracking-[0.1em] text-muted-foreground font-semibold">{s.label}</div>
                      <div className="font-display text-4xl font-medium text-foreground mt-2">{s.value}</div>
                    </div>
                    <div className={`w-10 h-10 rounded-xl ${s.bg} flex items-center justify-center`}>
                      <s.icon className={`w-5 h-5 ${s.color}`} strokeWidth={1.6} />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="bg-card border border-border rounded-2xl overflow-hidden">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-5 border-b border-border">
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Rechercher un fichier ou code…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="pl-9 h-10 w-full sm:w-72 rounded-lg"
                      data-testid="input-search"
                    />
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-10 rounded-lg" data-testid="btn-filter">
                        <Filter className="w-4 h-4 mr-1.5" />
                        {filter === "all" ? "Tous" : filter === "signed" ? "Signés" : "Non signés"}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={() => setFilter("all")} data-testid="filter-all">Tous</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setFilter("signed")} data-testid="filter-signed">Signés</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setFilter("unsigned")} data-testid="filter-unsigned">Non signés</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-10 rounded-lg" data-testid="btn-sort">
                        <ArrowDownUp className="w-4 h-4 mr-1.5" /> {sortLabel}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={() => setSortBy("created_desc")} data-testid="sort-created-desc">Date d'ajout · Plus récent</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setSortBy("created_asc")} data-testid="sort-created-asc">Date d'ajout · Plus ancien</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setSortBy("signed_desc")} data-testid="sort-signed-desc">Date de signature · Plus récent</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setSortBy("signed_asc")} data-testid="sort-signed-asc">Date de signature · Plus ancien</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
                  <DialogTrigger asChild>
                    <Button className="h-10 rounded-lg bg-brand text-white" data-testid="btn-upload-open">
                      <Upload className="w-4 h-4 mr-2" /> Ajouter un fichier
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle className="font-display tracking-tight">Ajouter un devis</DialogTitle>
                      <DialogDescription>Téléversez un fichier PDF (10 MB maximum).</DialogDescription>
                    </DialogHeader>
                    <form onSubmit={handleUpload} className="space-y-4" data-testid="upload-form">
                      <label className="block">
                        <div className="border-2 border-dashed border-border rounded-xl p-8 text-center hover:border-brand transition-colors cursor-pointer">
                          <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" strokeWidth={1.5} />
                          <div className="text-sm font-medium text-foreground">Cliquez pour choisir un PDF</div>
                          <div className="text-xs text-muted-foreground mt-1">ou glissez-déposez</div>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept="application/pdf"
                            className="hidden"
                            data-testid="input-file-upload"
                          />
                        </div>
                      </label>
                      <div>
                        <div className="text-xs uppercase tracking-[0.1em] font-semibold text-muted-foreground mb-2 flex items-center justify-between">
                          <span><Tag className="w-3 h-3 inline mr-1" /> Type de document</span>
                          <button
                            type="button"
                            onClick={() => setTypesManagerOpen(true)}
                            className="text-brand hover:underline text-[10px] normal-case tracking-normal"
                            data-testid="btn-manage-types"
                          >
                            <Settings className="w-3 h-3 inline mr-0.5" /> Gérer les types
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {documentTypes.map((t) => (
                            <button
                              key={t.id} type="button"
                              onClick={() => setUploadType(t.name)}
                              className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                                uploadType === t.name
                                  ? "bg-brand text-white border-brand"
                                  : "bg-card text-foreground border-border hover:border-foreground/30"
                              }`}
                              data-testid={`upload-type-${t.name}`}
                            >
                              {t.name}
                            </button>
                          ))}
                        </div>
                      </div>
                      <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setUploadOpen(false)} data-testid="btn-upload-cancel">
                          Annuler
                        </Button>
                        <Button type="submit" disabled={uploading} className="bg-brand text-white" data-testid="btn-upload-submit">
                          {uploading ? "Envoi…" : "Téléverser"}
                        </Button>
                      </DialogFooter>
                    </form>
                  </DialogContent>
                </Dialog>
              </div>

              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40 border-y border-border">
                      <TableHead className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Fichier</TableHead>
                      <TableHead className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Date d'ajout</TableHead>
                      <TableHead className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Statut</TableHead>
                      <TableHead className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Signé le</TableHead>
                      <TableHead className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Code d'accès</TableHead>
                      <TableHead className="text-xs uppercase tracking-wider font-semibold text-muted-foreground text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      <TableRow><TableCell colSpan={6} className="text-center py-12 text-muted-foreground">Chargement…</TableCell></TableRow>
                    ) : filtered.length === 0 ? (
                      <TableRow data-testid="empty-state">
                        <TableCell colSpan={6} className="text-center py-16">
                          <FileText className="w-10 h-10 mx-auto text-muted-foreground/50 mb-3" strokeWidth={1.4} />
                          <div className="text-sm text-muted-foreground">Aucun fichier pour le moment</div>
                          <div className="text-xs text-muted-foreground/70 mt-1">Cliquez sur "Ajouter un fichier" pour commencer</div>
                        </TableCell>
                      </TableRow>
                    ) : (
                      filtered.map((f) => {
                        const kids = childrenByParent[f.id] || [];
                        const isFolder = kids.length > 0;
                        const isExpanded = !!expanded[f.id];
                        const folderStatus = isFolder
                          ? ([f, ...kids].every((x) => x.status === "signed") ? "signed" : "unsigned")
                          : f.status;
                        const folderSignedAt = isFolder
                          ? (folderStatus === "signed" ? [f, ...kids].map((x) => x.signed_at).filter(Boolean).sort().pop() : null)
                          : f.signed_at;
                        return (
                        <Fragment key={f.id}>
                        <TableRow className={`hover:bg-muted/40 ${isFolder ? "bg-muted/20" : ""}`} data-testid={`row-file-${f.id}`}>
                          <TableCell className="py-4">
                            <div className="flex items-center gap-3">
                              {isFolder ? (
                                <button
                                  onClick={() => toggleExpand(f.id)}
                                  className="flex items-center justify-center w-9 h-9 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 transition-colors"
                                  data-testid={`btn-expand-${f.id}`}
                                  title={isExpanded ? "Replier le dossier" : "Déplier le dossier"}
                                >
                                  {isExpanded
                                    ? <FolderOpen className="w-4 h-4 text-amber-600 dark:text-amber-400" strokeWidth={1.6} />
                                    : <Folder className="w-4 h-4 text-amber-600 dark:text-amber-400" strokeWidth={1.6} />
                                  }
                                </button>
                              ) : (
                                <div className="w-9 h-9 rounded-lg bg-brand/10 flex items-center justify-center flex-shrink-0">
                                  <FileText className="w-4 h-4 text-brand" strokeWidth={1.6} />
                                </div>
                              )}
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-foreground truncate max-w-[280px] flex items-center gap-2">
                                  {isFolder ? (
                                    <button onClick={() => toggleExpand(f.id)} className="truncate text-left hover:underline" data-testid={`btn-folder-name-${f.id}`}>
                                      Dossier — {f.filename.replace(/\.pdf$/i, "")}
                                    </button>
                                  ) : (
                                    <span className="truncate">{f.filename}</span>
                                  )}
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-brand/10 text-brand text-[10px] font-semibold uppercase tracking-wider flex-shrink-0">
                                    <Tag className="w-2.5 h-2.5" /> {isFolder ? `${1 + kids.length} docs` : (f.document_type || "Devis")}
                                  </span>
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {(f.size / 1024).toFixed(1)} KB
                                  {user?.role === "super_admin" && f.created_by_username && (
                                    <span className="ml-2">· par <span className="font-medium">{f.created_by_username}</span></span>
                                  )}
                                  {!isFolder && f.signature_position && f.status !== "signed" && (
                                    <span className="ml-2 inline-flex items-center gap-1 opacity-70">
                                      <MoveDiagonal className="w-3 h-3" />
                                      {(f.fields || []).some((x) => x.type === "signature")
                                        ? "Position personnalisée"
                                        : positionLabel(f.signature_position)}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-foreground/80">
                            {formatDate(f.created_at)}
                          </TableCell>
                          <TableCell><StatusBadge status={folderStatus} /></TableCell>
                          <TableCell className="text-sm text-foreground/80" data-testid={`signed-at-${f.id}`}>
                            {folderStatus === "signed" ? formatDateTime(folderSignedAt) : "—"}
                          </TableCell>
                          <TableCell>
                            {f.access_code ? (
                              <button
                                onClick={() => copyCode(f.access_code)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-muted hover:bg-muted/70 transition-colors font-mono text-xs text-foreground"
                                data-testid={`btn-copy-code-${f.id}`}
                                title={isFolder ? "Code dossier — signe tous les documents" : "Code d'accès"}
                              >
                                {f.access_code}
                                <Copy className="w-3 h-3 opacity-60" />
                              </button>
                            ) : (
                              <Button
                                size="sm" variant="outline" className="h-8 rounded-lg"
                                onClick={() => handleGenerateCode(f.id)}
                                data-testid={`btn-generate-code-${f.id}`}
                              >
                                <KeyRound className="w-3.5 h-3.5 mr-1.5" /> Générer {isFolder ? "code dossier" : ""}
                              </Button>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 rounded-lg" data-testid={`btn-actions-${f.id}`}>
                                  <MoreHorizontal className="w-4 h-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => handlePreview(f)} data-testid={`menu-view-${f.id}`}>
                                  <Eye className="w-4 h-4 mr-2" /> Voir
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => openRename(f)} data-testid={`menu-rename-${f.id}`}>
                                  <Pencil className="w-4 h-4 mr-2" /> Renommer {isFolder ? "le dossier" : ""}
                                </DropdownMenuItem>
                                {f.access_code && (
                                  <DropdownMenuItem onClick={() => copyDirectLink(f)} data-testid={`menu-link-${f.id}`}>
                                    <Link2 className="w-4 h-4 mr-2" /> Copier lien direct signataire
                                  </DropdownMenuItem>
                                )}
                                {!f.parent_file_id && (
                                  <DropdownMenuItem onClick={() => setLinkParent(f)} data-testid={`menu-link-doc-${f.id}`}>
                                    <Paperclip className="w-4 h-4 mr-2" /> Lier un autre document
                                  </DropdownMenuItem>
                                )}
                                {!f.parent_file_id && f.status !== "signed" && (
                                  <DropdownMenuItem onClick={() => handleLinkAttestation(f)} data-testid={`menu-link-attestation-${f.id}`}>
                                    <FileCheck2 className="w-4 h-4 mr-2" /> Lier Attestation Simplifiée
                                  </DropdownMenuItem>
                                )}
                                {!isFolder && (
                                  <DropdownMenuItem onClick={() => openTypeEdit(f)} data-testid={`menu-type-${f.id}`}>
                                    <Tag className="w-4 h-4 mr-2" /> Modifier le type
                                  </DropdownMenuItem>
                                )}
                                {!isFolder && f.status !== "signed" && (
                                  <DropdownMenuItem onClick={() => openPosition(f)} data-testid={`menu-position-${f.id}`}>
                                    <MoveDiagonal className="w-4 h-4 mr-2" /> Position signature
                                  </DropdownMenuItem>
                                )}
                                {!isFolder && f.status !== "signed" && (
                                  <DropdownMenuItem onClick={() => setCustomPosFile(f)} data-testid={`menu-custom-position-${f.id}`}>
                                    <Move className="w-4 h-4 mr-2" /> Position personnalisée (drag &amp; drop)
                                  </DropdownMenuItem>
                                )}
                                {!isFolder && (
                                  <DropdownMenuItem onClick={() => handleToggleStatus(f)} data-testid={`menu-toggle-${f.id}`}>
                                    <FileSignature className="w-4 h-4 mr-2" /> Marquer {f.status === "signed" ? "non signé" : "signé"}
                                  </DropdownMenuItem>
                                )}
                                {!f.access_code && (
                                  <DropdownMenuItem onClick={() => handleGenerateCode(f.id)} data-testid={`menu-code-${f.id}`}>
                                    <KeyRound className="w-4 h-4 mr-2" /> Générer un code
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="text-destructive focus:text-destructive" data-testid={`menu-delete-${f.id}`}>
                                      <Trash2 className="w-4 h-4 mr-2" /> Supprimer {isFolder ? "le dossier" : ""}
                                    </DropdownMenuItem>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>{isFolder ? "Supprimer ce dossier ?" : "Supprimer ce fichier ?"}</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        {isFolder
                                          ? `Le dossier "${f.filename}" et ses ${kids.length} document(s) lié(s) seront supprimés définitivement.`
                                          : `Le fichier "${f.filename}" et son code d'accès seront supprimés définitivement.`}
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel data-testid={`btn-delete-cancel-${f.id}`}>Annuler</AlertDialogCancel>
                                      <AlertDialogAction
                                        className="bg-destructive text-destructive-foreground hover:opacity-90"
                                        onClick={() => handleDelete(f.id)}
                                        data-testid={`btn-delete-confirm-${f.id}`}
                                      >
                                        Supprimer
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                        {/* Child rows when folder expanded */}
                        {isFolder && isExpanded && kids.map((c) => (
                          <TableRow key={c.id} className="hover:bg-muted/40 bg-background/50" data-testid={`row-child-${c.id}`}>
                            <TableCell className="py-3">
                              <div className="flex items-center gap-3 pl-10">
                                <div className="w-7 h-7 rounded-md bg-brand/10 flex items-center justify-center flex-shrink-0">
                                  <FileText className="w-3.5 h-3.5 text-brand" strokeWidth={1.6} />
                                </div>
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-foreground truncate max-w-[260px] flex items-center gap-2">
                                    <span className="truncate">↳ {c.signed_filename || c.filename}</span>
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-brand/10 text-brand text-[10px] font-semibold uppercase tracking-wider flex-shrink-0">
                                      <Tag className="w-2.5 h-2.5" /> {c.document_type || "Devis"}
                                    </span>
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {(c.size / 1024).toFixed(1)} KB
                                  </div>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">—</TableCell>
                            <TableCell><StatusBadge status={c.status} /></TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {c.status === "signed" ? formatDateTime(c.signed_at) : "—"}
                            </TableCell>
                            <TableCell><span className="text-xs text-muted-foreground italic">code dossier</span></TableCell>
                            <TableCell className="text-right">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 rounded-lg" data-testid={`btn-actions-${c.id}`}>
                                    <MoreHorizontal className="w-4 h-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => handlePreview(c)} data-testid={`menu-view-${c.id}`}>
                                    <Eye className="w-4 h-4 mr-2" /> Voir
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => openRename(c)} data-testid={`menu-rename-${c.id}`}>
                                    <Pencil className="w-4 h-4 mr-2" /> Renommer
                                  </DropdownMenuItem>
                                  {c.status !== "signed" && (
                                    <DropdownMenuItem onClick={() => setCustomPosFile(c)} data-testid={`menu-custom-position-${c.id}`}>
                                      <Move className="w-4 h-4 mr-2" /> Position signature
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuSeparator />
                                  <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                      <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="text-destructive focus:text-destructive" data-testid={`menu-delete-${c.id}`}>
                                        <Trash2 className="w-4 h-4 mr-2" /> Retirer du dossier
                                      </DropdownMenuItem>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                      <AlertDialogHeader>
                                        <AlertDialogTitle>Supprimer ce document du dossier ?</AlertDialogTitle>
                                        <AlertDialogDescription>
                                          "{c.filename}" sera supprimé définitivement du dossier.
                                        </AlertDialogDescription>
                                      </AlertDialogHeader>
                                      <AlertDialogFooter>
                                        <AlertDialogCancel>Annuler</AlertDialogCancel>
                                        <AlertDialogAction
                                          className="bg-destructive text-destructive-foreground hover:opacity-90"
                                          onClick={() => handleDelete(c.id)}
                                        >
                                          Supprimer
                                        </AlertDialogAction>
                                      </AlertDialogFooter>
                                    </AlertDialogContent>
                                  </AlertDialog>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableCell>
                          </TableRow>
                        ))}
                        </Fragment>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          {user?.role === "super_admin" && (
            <TabsContent value="managers" className="mt-0">
              <ManagersPanel />
            </TabsContent>
          )}

          {user?.role === "super_admin" && (
            <TabsContent value="database" className="mt-0">
              <DatabaseExplorer />
            </TabsContent>
          )}
        </Tabs>
      </main>

      {/* Preview Dialog */}
      <Dialog open={!!previewFile} onOpenChange={(o) => {
        if (!o) {
          if (previewFile?.blobUrl) revokeBlobUrl(previewFile.blobUrl);
          setPreviewFile(null);
        }
      }}>
        <DialogContent className="max-w-4xl h-[85vh] flex flex-col p-0">
          <DialogHeader className="p-5 border-b border-border">
            <DialogTitle className="font-display tracking-tight truncate">{previewFile?.filename}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 bg-muted overflow-hidden">
            {previewFile?.blobUrl && (
              <PdfViewer blobUrl={previewFile.blobUrl} filename={previewFile.filename} />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Signature position dialog */}
      <Dialog open={!!positionFile} onOpenChange={(o) => !o && setPositionFile(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display tracking-tight">Position de la signature</DialogTitle>
            <DialogDescription>
              Choisissez où la signature électronique sera placée sur la dernière page du document.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <SignaturePositionPicker value={positionValue} onChange={setPositionValue} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPositionFile(null)} data-testid="btn-position-cancel">
              Annuler
            </Button>
            <Button onClick={savePosition} className="bg-brand text-white" data-testid="btn-position-save">
              Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Document type change dialog */}
      <Dialog open={!!typeFile} onOpenChange={(o) => !o && setTypeFile(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display tracking-tight">Type de document</DialogTitle>
            <DialogDescription>
              Modifier le type de "{typeFile?.filename}". La position par défaut du nouveau type sera appliquée si le document n'est pas encore signé.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="grid grid-cols-2 gap-2">
              {documentTypes.map((t) => (
                <button
                  key={t.id} type="button"
                  onClick={() => setTypeValue(t.name)}
                  className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                    typeValue === t.name
                      ? "bg-brand text-white border-brand"
                      : "bg-card text-foreground border-border hover:border-foreground/30"
                  }`}
                  data-testid={`type-select-${t.name}`}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTypeFile(null)} data-testid="btn-type-cancel">
              Annuler
            </Button>
            <Button onClick={saveType} className="bg-brand text-white" data-testid="btn-type-save">
              Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Link Document dialog */}
      <Dialog open={!!linkParent} onOpenChange={(o) => {
        if (!o) { setLinkParent(null); setLinkExistingChild(""); setLinkMode("upload"); }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display tracking-tight">Lier un autre document</DialogTitle>
            <DialogDescription>
              Le document partagera le code d'accès de <span className="font-medium">{linkParent?.filename}</span>. Tout sera signé en une seule action. Le PDF lié signé sera enregistré comme <span className="font-mono text-xs">{"{" }devis{ "}"}+{"{"}fichier_lié{"}"}.pdf</span>.
            </DialogDescription>
          </DialogHeader>

          {/* Mode tabs */}
          <div className="flex p-1 bg-muted rounded-lg" data-testid="link-mode-tabs">
            <button
              type="button"
              onClick={() => setLinkMode("upload")}
              className={`flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                linkMode === "upload" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"
              }`}
              data-testid="link-tab-upload"
            >
              <Upload className="w-3.5 h-3.5 inline mr-1.5" /> Téléverser nouveau
            </button>
            <button
              type="button"
              onClick={() => setLinkMode("existing")}
              className={`flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                linkMode === "existing" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"
              }`}
              data-testid="link-tab-existing"
            >
              <Files className="w-3.5 h-3.5 inline mr-1.5" /> Choisir existant
            </button>
          </div>

          <form onSubmit={handleLinkUpload} className="space-y-4" data-testid="link-form">
            {linkMode === "upload" ? (
              <>
                <label className="block">
                  <div className="border-2 border-dashed border-border rounded-xl p-6 text-center hover:border-brand transition-colors cursor-pointer">
                    <Paperclip className="w-7 h-7 mx-auto text-muted-foreground mb-2" strokeWidth={1.5} />
                    <div className="text-sm font-medium text-foreground">Choisir un PDF à lier</div>
                    <div className="text-xs text-muted-foreground mt-1">10 MB max</div>
                    <input
                      ref={linkFileRef}
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      data-testid="input-link-file"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) toast.info(`Sélectionné : ${f.name}`);
                      }}
                    />
                  </div>
                </label>
                <div>
                  <div className="text-xs uppercase tracking-[0.1em] font-semibold text-muted-foreground mb-2">
                    <Tag className="w-3 h-3 inline mr-1" /> Type de document
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {documentTypes.map((t) => (
                      <button
                        key={t.id} type="button"
                        onClick={() => setLinkType(t.name)}
                        className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                          linkType === t.name
                            ? "bg-brand text-white border-brand"
                            : "bg-card text-foreground border-border hover:border-foreground/30"
                        }`}
                        data-testid={`link-type-${t.name}`}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto" data-testid="link-existing-list">
                {files
                  .filter((x) =>
                    x.id !== linkParent?.id &&
                    !x.parent_file_id &&
                    x.status !== "signed"
                  )
                  .map((x) => (
                    <button
                      key={x.id}
                      type="button"
                      onClick={() => setLinkExistingChild(x.id)}
                      className={`w-full text-left p-3 rounded-lg border transition-all ${
                        linkExistingChild === x.id
                          ? "bg-brand/10 border-brand"
                          : "bg-card border-border hover:border-foreground/30"
                      }`}
                      data-testid={`link-existing-${x.id}`}
                    >
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-brand flex-shrink-0" strokeWidth={1.6} />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-foreground truncate">{x.filename}</div>
                          <div className="text-xs text-muted-foreground">
                            {x.document_type} · {(x.size / 1024).toFixed(1)} KB
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                {files.filter((x) => x.id !== linkParent?.id && !x.parent_file_id && x.status !== "signed").length === 0 && (
                  <div className="text-center text-sm text-muted-foreground py-8" data-testid="link-existing-empty">
                    Aucun document disponible.
                    <div className="text-xs mt-1">Les documents déjà liés ou signés sont exclus.</div>
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setLinkParent(null)} data-testid="btn-link-cancel">
                Annuler
              </Button>
              <Button type="submit" disabled={linkUploading} className="bg-brand text-white" data-testid="btn-link-submit">
                {linkUploading ? "Envoi…" : linkMode === "existing" ? "Lier le document" : "Téléverser & lier"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Custom signature position editor */}
      <SignaturePositionEditor
        file={customPosFile}
        onClose={() => setCustomPosFile(null)}
        onSaved={() => { setCustomPosFile(null); loadFiles(); }}
      />

      {/* Rename dialog */}
      <Dialog open={!!renameFile} onOpenChange={(o) => !o && setRenameFile(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display tracking-tight">
              <Pencil className="w-4 h-4 inline mr-2 text-brand" />
              Renommer {(childrenByParent[renameFile?.id] || []).length > 0 ? "le dossier" : "le fichier"}
            </DialogTitle>
            <DialogDescription>
              Nom actuel : <span className="font-mono text-xs">{renameFile?.filename}</span>
              {(childrenByParent[renameFile?.id] || []).length > 0 && (
                <span className="block mt-1.5 text-xs">
                  Les documents liés signés seront renommés automatiquement avec le nouveau préfixe.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => { e.preventDefault(); saveRename(); }}
            className="space-y-4"
            data-testid="rename-form"
          >
            <div className="flex items-center gap-2">
              <Input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="Nouveau nom (sans extension)"
                className="flex-1"
                autoFocus
                data-testid="input-rename"
              />
              <span className="text-sm text-muted-foreground font-mono">.pdf</span>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenameFile(null)} data-testid="btn-rename-cancel">
                Annuler
              </Button>
              <Button type="submit" className="bg-brand text-white" data-testid="btn-rename-save">
                Enregistrer
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Types manager dialog */}
      <Dialog open={typesManagerOpen} onOpenChange={setTypesManagerOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display tracking-tight">Gérer les types de documents</DialogTitle>
            <DialogDescription>
              Créez des types personnalisés (Devis, Attestation, Contrat…). Chaque type peut avoir une position par défaut de la signature.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 max-h-[400px] overflow-y-auto">
            <div className="space-y-2">
              {documentTypes.map((t) => (
                <div key={t.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/40 border border-border">
                  <div>
                    <div className="text-sm font-medium text-foreground">{t.name}</div>
                    <div className="text-xs text-muted-foreground">Position défaut : {positionLabel(t.default_signature_position)}</div>
                  </div>
                  {user?.role === "super_admin" && (
                    <Button
                      size="sm" variant="ghost"
                      className="h-8 w-8 p-0 text-destructive hover:bg-destructive/10"
                      onClick={() => deleteType(t.id, t.name)}
                      data-testid={`btn-type-delete-${t.name}`}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <form onSubmit={createType} className="border-t border-border pt-4 space-y-3">
              <div className="text-xs uppercase tracking-[0.1em] font-semibold text-muted-foreground">
                <Plus className="w-3 h-3 inline mr-1" /> Créer un nouveau type
              </div>
              <Input
                placeholder="ex: Mandat, Procuration…"
                value={newTypeName}
                onChange={(e) => setNewTypeName(e.target.value)}
                className="h-10 rounded-lg"
                data-testid="input-new-type-name"
              />
              <div>
                <div className="text-xs text-muted-foreground mb-2">Position par défaut de la signature</div>
                <SignaturePositionPicker value={newTypePos} onChange={setNewTypePos} />
              </div>
              <Button type="submit" disabled={!newTypeName.trim()} className="w-full bg-brand text-white" data-testid="btn-create-type">
                Créer le type
              </Button>
            </form>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTypesManagerOpen(false)} data-testid="btn-types-close">
              Fermer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
