import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  CheckCircle2, Eraser, FileText, ShieldCheck, ArrowLeft, PenLine, Loader2, Files,
} from "lucide-react";
import { toast } from "sonner";
import api, { formatApiError } from "../lib/api";
import { base64ToBlobUrl, revokeBlobUrl } from "../lib/pdf";
import ThemeToggle from "../components/ThemeToggle";
import PdfViewer from "../components/PdfViewer";

export default function SignaturePage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [documents, setDocuments] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [pdfUrls, setPdfUrls] = useState({});  // {fileId: blobUrl}
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [signed, setSigned] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const [fieldValues, setFieldValues] = useState({});
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });

  // Load all documents linked to this access code
  useEffect(() => {
    let abort = false;
    const created = {};
    (async () => {
      try {
        const { data } = await api.get(`/access/file/${encodeURIComponent(code)}`);
        if (abort) return;
        const docs = data.documents || [];
        setDocuments(docs);
        if (data.all_signed) setSigned(true);

        // Create blob URLs for each doc
        for (const d of docs) {
          const url = base64ToBlobUrl(d.content_b64);
          if (url) created[d.id] = url;
        }
        setPdfUrls(created);

        // Init field values from all docs' field defs
        const fv = {};
        docs.forEach((d) => {
          (d.fields || []).forEach((f) => {
            if (f.type !== "signature" && f.type !== "date_auto") {
              fv[f.name] = fv[f.name] || "";
            }
          });
        });
        setFieldValues(fv);
      } catch (e) {
        if (!abort) toast.error(formatApiError(e.response?.data?.detail) || "Code invalide");
        setTimeout(() => !abort && navigate("/login"), 1200);
      } finally {
        if (!abort) setLoading(false);
      }
    })();
    return () => {
      abort = true;
      Object.values(created).forEach(revokeBlobUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // Setup canvas (always white bg + black strokes for PDF readability)
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const setup = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = c.getBoundingClientRect();
      c.width = rect.width * dpr;
      c.height = rect.height * dpr;
      const ctx = c.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#0a0a0a";
      ctx.lineWidth = 2.2;
    };
    setup();
    window.addEventListener("resize", setup);
    return () => window.removeEventListener("resize", setup);
  }, [documents, signed]);

  const getPos = (e) => {
    const c = canvasRef.current;
    const rect = c.getBoundingClientRect();
    const t = e.touches?.[0];
    const cx = t ? t.clientX : e.clientX;
    const cy = t ? t.clientY : e.clientY;
    return { x: cx - rect.left, y: cy - rect.top };
  };
  const startDraw = (e) => { e.preventDefault(); drawingRef.current = true; lastPosRef.current = getPos(e); };
  const drawMove = (e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    lastPosRef.current = { x, y };
    if (!hasDrawn) setHasDrawn(true);
  };
  const endDraw = () => { drawingRef.current = false; };
  const clearCanvas = () => {
    const c = canvasRef.current; const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height); setHasDrawn(false);
  };

  // Get unique form fields across ALL documents (deduplicated by name)
  const allFields = (() => {
    const map = {};
    documents.forEach((d) => {
      (d.fields || []).forEach((f) => {
        if (f.type === "signature" || f.type === "date_auto") return;
        if (!map[f.name]) map[f.name] = f;
      });
    });
    return Object.values(map);
  })();

  const validateSignature = async () => {
    if (!hasDrawn) {
      toast.error("Veuillez signer dans la zone prévue");
      return;
    }
    // Validate required fields
    const missing = allFields.filter((f) => f.required && !(fieldValues[f.name] || "").trim());
    if (missing.length) {
      toast.error(`Champs requis : ${missing.map((f) => f.label).join(", ")}`);
      return;
    }
    // Build transparent cropped PNG of signature
    const c = canvasRef.current;
    const ctx = c.getContext("2d");
    const w = c.width, h = c.height;
    const img = ctx.getImageData(0, 0, w, h);
    let minX=w, minY=h, maxX=0, maxY=0, found=false;
    for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
      const a = img.data[(y*w + x)*4 + 3];
      if (a > 8) { if(x<minX)minX=x; if(y<minY)minY=y; if(x>maxX)maxX=x; if(y>maxY)maxY=y; found=true; }
    }
    if (!found) { toast.error("Signature illisible — recommencez"); return; }
    const pad = 8;
    minX = Math.max(0, minX-pad); minY = Math.max(0, minY-pad);
    maxX = Math.min(w-1, maxX+pad); maxY = Math.min(h-1, maxY+pad);
    const cropW = maxX-minX+1, cropH = maxY-minY+1;
    const tmp = document.createElement("canvas");
    tmp.width = cropW; tmp.height = cropH;
    tmp.getContext("2d").drawImage(c, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
    const dataUrl = tmp.toDataURL("image/png");

    setSubmitting(true);
    try {
      await api.post(`/access/sign/${encodeURIComponent(code)}`, {
        signature_data_url: dataUrl,
        field_values: fieldValues,
      });
      setSigned(true);
      toast.success("Document signé avec succès");
      // Refresh signed PDFs
      try {
        const { data } = await api.get(`/access/file/${encodeURIComponent(code)}`);
        setDocuments(data.documents || []);
        Object.values(pdfUrls).forEach(revokeBlobUrl);
        const nu = {};
        (data.documents || []).forEach((d) => {
          const u = base64ToBlobUrl(d.content_b64);
          if (u) nu[d.id] = u;
        });
        setPdfUrls(nu);
      } catch {}
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Erreur lors de la signature");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Chargement des documents…
      </div>
    </div>
  );

  if (!documents.length) return null;
  const currentDoc = documents[currentIdx];
  const isMulti = documents.length > 1;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="glass sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-6 sm:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand flex items-center justify-center">
              <FileText className="w-4 h-4 text-white" strokeWidth={1.8} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" /> Connexion sécurisée
            </span>
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={() => navigate("/login")} data-testid="btn-back">
              <ArrowLeft className="w-4 h-4 mr-1.5" /> Retour
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-6 sm:px-8 py-8">
        <div className="mb-6 fade-in">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-muted text-muted-foreground text-xs font-mono mb-3" data-testid="access-code-display">
            {code}
          </div>
          <h1 className="font-display text-3xl sm:text-4xl tracking-tight font-medium text-foreground">
            {isMulti ? `${documents.length} documents à signer` : currentDoc.filename}
          </h1>
          <p className="text-muted-foreground mt-2">
            {signed
              ? "Vos documents ont été signés. Vous pouvez les consulter ci-dessous."
              : isMulti
                ? "Remplissez les informations, puis signez. Tous les documents seront signés en une fois."
                : "Veuillez consulter le document, remplir les informations puis signer."}
          </p>
        </div>

        {signed && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-6 mb-6 flex items-start gap-4 fade-in" data-testid="signed-banner">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500 flex items-center justify-center flex-shrink-0">
              <CheckCircle2 className="w-6 h-6 text-white" strokeWidth={1.8} />
            </div>
            <div>
              <h2 className="font-display text-xl font-medium text-emerald-700 dark:text-emerald-300">
                {isMulti ? `Les ${documents.length} documents ont été signés avec succès.` : "Document signé avec succès."}
              </h2>
              <p className="text-emerald-700/80 dark:text-emerald-300/80 text-sm mt-1">Votre signature a été intégrée. Une copie a été enregistrée.</p>
            </div>
          </div>
        )}

        {/* Document switcher for multi-doc */}
        {isMulti && (
          <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-2">
            <Files className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            {documents.map((d, idx) => (
              <button
                key={d.id}
                onClick={() => setCurrentIdx(idx)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border whitespace-nowrap transition-colors ${
                  currentIdx === idx
                    ? "bg-brand text-white border-brand"
                    : "bg-card text-foreground border-border hover:border-foreground/30"
                }`}
                data-testid={`doc-tab-${idx}`}
              >
                {idx + 1}. {d.filename}
                {d.status === "signed" && <CheckCircle2 className="w-3 h-3 ml-1.5 inline text-emerald-500" />}
              </button>
            ))}
          </div>
        )}

        <div className="grid lg:grid-cols-5 gap-6">
          {/* PDF preview */}
          <div className="lg:col-span-3 bg-card border border-border rounded-2xl overflow-hidden flex flex-col" style={{ height: "75vh" }}>
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-muted-foreground" strokeWidth={1.6} />
                <span className="text-sm font-medium text-foreground truncate">{currentDoc.filename}</span>
              </div>
              <span className="text-xs text-muted-foreground">{currentDoc.document_type}</span>
            </div>
            {pdfUrls[currentDoc.id] ? (
              <div className="flex-1 min-h-0">
                <PdfViewer blobUrl={pdfUrls[currentDoc.id]} filename={currentDoc.filename} />
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                Impossible d'afficher le PDF
              </div>
            )}
          </div>

          {/* Right panel: unified signing card (fields + signature) */}
          <div className="lg:col-span-2 space-y-4">
            {!signed ? (
              <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
                {/* Header */}
                <div className="px-6 pt-6 pb-4 border-b border-border bg-gradient-to-b from-muted/30 to-transparent">
                  <div className="flex items-center gap-2 mb-1">
                    <PenLine className="w-4 h-4 text-brand" strokeWidth={1.8} />
                    <span className="text-xs uppercase tracking-[0.12em] font-semibold text-muted-foreground">
                      Signature du document
                    </span>
                  </div>
                  <h3 className="font-display text-2xl font-medium text-foreground">
                    {isMulti ? `Signer ${documents.length} documents` : "Signer le document"}
                  </h3>
                </div>

                {/* Fields */}
                {allFields.length > 0 && (
                  <div className="px-6 pt-5 space-y-3">
                    {allFields.map((f) => (
                      <div key={f.name} data-testid={`field-row-${f.name}`}>
                        <Label className="text-foreground/90 text-xs font-medium uppercase tracking-wider">
                          {f.label} {f.required && <span className="text-destructive">*</span>}
                        </Label>
                        <Input
                          value={fieldValues[f.name] || ""}
                          onChange={(e) => setFieldValues((p) => ({ ...p, [f.name]: e.target.value }))}
                          className="mt-1.5 h-11 rounded-xl bg-muted/40 border-border focus:bg-card text-base"
                          placeholder={f.label}
                          data-testid={`input-field-${f.name}`}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* Signature pad */}
                <div className="px-6 pt-5 pb-6">
                  <Label className="text-foreground/90 text-xs font-medium uppercase tracking-wider">
                    Votre signature <span className="text-destructive">*</span>
                  </Label>
                  <div
                    className="relative rounded-2xl overflow-hidden border-2 border-border bg-white mt-1.5"
                    style={{ minHeight: 200 }}
                  >
                    <canvas
                      ref={canvasRef}
                      className="signature-canvas absolute inset-0 w-full h-full"
                      onMouseDown={startDraw} onMouseMove={drawMove} onMouseUp={endDraw} onMouseLeave={endDraw}
                      onTouchStart={startDraw} onTouchMove={drawMove} onTouchEnd={endDraw}
                      data-testid="signature-canvas"
                    />
                    {!hasDrawn && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                        <PenLine className="w-6 h-6 text-slate-400 mb-1" strokeWidth={1.4} />
                        <span className="text-slate-500 text-sm italic">Signez ici à la souris ou au doigt</span>
                      </div>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-2 text-center">
                    Signez en noir sur fond transparent
                  </p>

                  <div className="flex items-center gap-3 mt-5">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={clearCanvas}
                      className="flex-1 h-11 rounded-xl"
                      disabled={submitting}
                      data-testid="btn-clear-signature"
                    >
                      <Eraser className="w-4 h-4 mr-2" /> Effacer
                    </Button>
                    <Button
                      type="button"
                      onClick={validateSignature}
                      disabled={submitting || !hasDrawn}
                      className="flex-[1.5] h-11 rounded-xl bg-brand text-white shadow-md hover:shadow-lg transition-all disabled:opacity-50"
                      data-testid="btn-validate-signature"
                    >
                      {submitting ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Validation…</>
                      ) : (
                        <><CheckCircle2 className="w-4 h-4 mr-2" /> Confirmer la signature</>
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-4 leading-relaxed">
                    En validant, vous reconnaissez que cette signature électronique a la même valeur juridique qu'une signature manuscrite.
                    {isMulti && " Tous les documents listés seront signés simultanément."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="bg-card border border-border rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-1">
                  <PenLine className="w-4 h-4 text-brand" strokeWidth={1.8} />
                  <span className="text-xs uppercase tracking-[0.1em] font-semibold text-muted-foreground">Signature enregistrée</span>
                </div>
                <h3 className="font-display text-xl font-medium text-foreground mb-4">Document signé</h3>
                <div className="flex items-center justify-center bg-emerald-500/5 rounded-xl border border-emerald-500/30 p-8">
                  <CheckCircle2 className="w-12 h-12 text-emerald-500" strokeWidth={1.5} />
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="border-t border-border py-6 mt-8">
        <div className="max-w-7xl mx-auto px-6 sm:px-8 text-xs text-muted-foreground flex items-center justify-between">
          <span>Plateforme sécurisée</span>
          <span className="font-mono">{code}</span>
        </div>
      </footer>
    </div>
  );
}
