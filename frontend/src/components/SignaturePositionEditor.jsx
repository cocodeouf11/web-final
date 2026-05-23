import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { Loader2, ChevronLeft, ChevronRight, MoveDiagonal, Save, X, Move } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "./ui/dialog";
import api, { formatApiError } from "../lib/api";
import { base64ToBlobUrl, revokeBlobUrl } from "../lib/pdf";
import { toast } from "sonner";

// Worker loaded same way as PdfViewer — same-origin backend route with CDN fallback.
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
const PRIMARY_WORKER = `${BACKEND_URL}/api/pdf-worker.mjs`;
const FALLBACK_WORKER = `https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs`;

let workerInitPromise = null;
function ensureWorker() {
  if (!workerInitPromise) {
    workerInitPromise = Promise.resolve().then(() => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = PRIMARY_WORKER;
      return PRIMARY_WORKER;
    });
  }
  return workerInitPromise;
}

const DEFAULT_BOX = { width: 220, height: 80 };

/**
 * Visual drag & drop editor to place the signature rectangle anywhere on the PDF.
 * Saves to /files/{id}/fields with a field of type "signature".
 *
 * Coordinates returned are in PDF points (origin = bottom-left).
 */
export default function SignaturePositionEditor({ file, onClose, onSaved }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [renderScale, setRenderScale] = useState(1);  // pdf points -> screen px
  const [renderSize, setRenderSize] = useState({ w: 0, h: 0 });
  const [pageHeightPts, setPageHeightPts] = useState(0);
  const [pageWidthPts, setPageWidthPts] = useState(0);
  const [blobUrl, setBlobUrl] = useState(null);  // eslint-disable-line no-unused-vars
  const blobUrlRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pageReady, setPageReady] = useState(false);  // becomes true after canvas is rendered for the current page

  // Box state in PDF points (origin bottom-left). page is 1-based.
  const [box, setBox] = useState({ x: 0, y: 0, width: DEFAULT_BOX.width, height: DEFAULT_BOX.height, page: 1 });

  const draggingRef = useRef(null); // {mode: 'move'|'resize', startX, startY, startBox}

  // Load PDF when file changes
  useEffect(() => {
    if (!file) { setPdfDoc(null); return; }
    let cancelled = false;
    setLoading(true);
    setPageReady(false);
    setPageHeightPts(0);
    setPageWidthPts(0);
    setRenderSize({ w: 0, h: 0 });
    (async () => {
      try {
        await ensureWorker();
        const { data } = await api.get(`/files/${file.id}/download`);
        if (cancelled) return;
        const url = base64ToBlobUrl(data.content_b64);
        if (!url) throw new Error("blob");
        setBlobUrl(url);
        blobUrlRef.current = url;
        const doc = await pdfjsLib.getDocument({ url }).promise;
        if (cancelled) return;
        setPdfDoc(doc);
        setNumPages(doc.numPages);

        // Initial: use existing signature field if present, else default bottom-right of page 1
        const sigField = (file.fields || []).find((f) => f.type === "signature");
        if (sigField) {
          setBox({
            x: sigField.x || 0,
            y: sigField.y || 0,
            width: sigField.width || DEFAULT_BOX.width,
            height: sigField.height || DEFAULT_BOX.height,
            page: sigField.page || 1,
          });
          setPageNum(sigField.page || 1);
        } else {
          // Default: bottom-right of first page
          const firstPage = await doc.getPage(1);
          const vp = firstPage.getViewport({ scale: 1 });
          setBox({
            x: Math.max(36, vp.width - DEFAULT_BOX.width - 36),
            y: 36,
            width: DEFAULT_BOX.width,
            height: DEFAULT_BOX.height,
            page: 1,
          });
          setPageNum(1);
        }
      } catch (e) {
        if (!cancelled) toast.error("Impossible de charger le PDF");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        revokeBlobUrl(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  // Render the current page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || !containerRef.current) return;
    let cancelled = false;
    setPageReady(false);  // hide box until the new page is painted
    (async () => {
      const page = await pdfDoc.getPage(pageNum);
      if (cancelled) return;
      const containerWidth = containerRef.current.clientWidth - 32;
      const baseViewport = page.getViewport({ scale: 1 });
      const fitScale = Math.min(1.5, containerWidth / baseViewport.width);
      const viewport = page.getViewport({ scale: fitScale });

      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      canvas.width = viewport.width * dpr;
      canvas.height = viewport.height * dpr;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);

      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      if (cancelled) return;
      setRenderScale(fitScale);
      setRenderSize({ w: viewport.width, h: viewport.height });
      setPageHeightPts(baseViewport.height);
      setPageWidthPts(baseViewport.width);
      // Wait one paint frame to make sure the canvas is on screen before revealing the box
      requestAnimationFrame(() => {
        if (!cancelled) setPageReady(true);
      });
    })();
    return () => { cancelled = true; };
  }, [pdfDoc, pageNum]);

  // Convert PDF-pts (origin bottom-left) → screen-px (origin top-left) for current page
  const ptsToScreen = (xPts, yPts, wPts, hPts) => {
    const px = xPts * renderScale;
    const py = (pageHeightPts - yPts - hPts) * renderScale;
    return { left: px, top: py, width: wPts * renderScale, height: hPts * renderScale };
  };

  // Convert delta screen px → delta pdf pts
  const pxToPts = (px) => px / renderScale;

  const onPointerDown = (e, mode) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startBox: { ...box },
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const onPointerMove = (e) => {
    const drag = draggingRef.current;
    if (!drag) return;
    const dxPx = e.clientX - drag.startX;
    const dyPx = e.clientY - drag.startY;
    const dxPts = pxToPts(dxPx);
    const dyPts = pxToPts(dyPx);
    if (drag.mode === "move") {
      // moving in screen → x grows right (pdf x grows right), y grows down (pdf y grows up so subtract)
      let nx = drag.startBox.x + dxPts;
      let ny = drag.startBox.y - dyPts;
      // Clamp inside page
      nx = Math.max(0, Math.min(pageWidthPts - drag.startBox.width, nx));
      ny = Math.max(0, Math.min(pageHeightPts - drag.startBox.height, ny));
      setBox((b) => ({ ...b, x: nx, y: ny }));
    } else if (drag.mode === "resize") {
      let nw = Math.max(60, Math.min(pageWidthPts - drag.startBox.x, drag.startBox.width + dxPts));
      let nh = Math.max(30, Math.min(pageHeightPts - drag.startBox.y, drag.startBox.height + dyPts));
      // Adjust y so the box grows downward visually (which means decreasing PDF y)
      let ny = drag.startBox.y - (nh - drag.startBox.height);
      ny = Math.max(0, ny);
      setBox((b) => ({ ...b, width: nw, height: nh, y: ny }));
    }
  };

  const onPointerUp = () => {
    draggingRef.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };

  const save = async () => {
    if (!file) return;
    setSaving(true);
    try {
      // Replace any existing 'signature' field with new coords, keep other fields
      const others = (file.fields || []).filter((f) => f.type !== "signature");
      const newField = {
        name: "__signature__",
        label: "Signature",
        type: "signature",
        page: pageNum,
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
        required: true,
      };
      await api.patch(`/files/${file.id}/fields`, { fields: [...others, newField] });
      toast.success("Position personnalisée enregistrée");
      onSaved?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Erreur");
    } finally {
      setSaving(false);
    }
  };

  const clearCustom = async () => {
    if (!file) return;
    setSaving(true);
    try {
      const others = (file.fields || []).filter((f) => f.type !== "signature");
      await api.patch(`/files/${file.id}/fields`, { fields: others });
      toast.success("Position personnalisée retirée — utilisation de la position par défaut");
      onSaved?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Erreur");
    } finally {
      setSaving(false);
    }
  };

  // Sync box.page when navigating pages
  useEffect(() => { setBox((b) => ({ ...b, page: pageNum })); }, [pageNum]);

  const screenBox = pageHeightPts ? ptsToScreen(box.x, box.y, box.width, box.height) : null;

  return (
    <Dialog open={!!file} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="max-w-4xl h-[90vh] flex flex-col p-0" data-testid="signature-position-editor">
        <DialogHeader className="p-5 border-b border-border">
          <DialogTitle className="font-display tracking-tight">
            <MoveDiagonal className="w-4 h-4 inline mr-2 text-brand" />
            Position personnalisée de la signature
          </DialogTitle>
          <DialogDescription>
            Glissez le rectangle bleu pour positionner librement la zone de signature. Utilisez la poignée en bas à droite pour redimensionner.
          </DialogDescription>
        </DialogHeader>

        {/* Toolbar */}
        <div className="flex items-center justify-between gap-2 px-5 py-2 border-b border-border bg-muted/40">
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setPageNum((p) => Math.max(1, p - 1))} disabled={pageNum <= 1} data-testid="editor-prev">
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-xs font-medium min-w-[60px] text-center">{numPages ? `Page ${pageNum} / ${numPages}` : "—"}</span>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setPageNum((p) => Math.min(numPages, p + 1))} disabled={pageNum >= numPages} data-testid="editor-next">
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
          <div className="text-xs text-muted-foreground font-mono" data-testid="editor-coords">
            x:{Math.round(box.x)} y:{Math.round(box.y)} · w:{Math.round(box.width)} h:{Math.round(box.height)}
          </div>
        </div>

        <div ref={containerRef} className="flex-1 overflow-auto p-4 bg-muted/40 relative">
          {(loading || !pageReady) && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground bg-muted/60 backdrop-blur-sm z-10">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Chargement du document…
            </div>
          )}
          <div className="relative inline-block" style={{ width: renderSize.w || "auto" }}>
            <canvas
              ref={canvasRef}
              className="rounded-md shadow-md bg-white block"
              style={{ display: "block" }}
            />
            {pageReady && screenBox && (
              <div
                className="absolute border-2 border-brand bg-brand/15 backdrop-blur-[1px] rounded-md cursor-move select-none flex items-center justify-center"
                style={{
                  left: screenBox.left,
                  top: screenBox.top,
                  width: screenBox.width,
                  height: screenBox.height,
                }}
                onPointerDown={(e) => onPointerDown(e, "move")}
                data-testid="editor-box"
              >
                <span className="text-brand font-medium text-xs uppercase tracking-wider pointer-events-none inline-flex items-center gap-1.5">
                  <Move className="w-3.5 h-3.5" /> Signature ici
                </span>
                {/* Resize handle */}
                <div
                  className="absolute -right-1.5 -bottom-1.5 w-4 h-4 bg-brand border-2 border-white dark:border-card rounded-sm cursor-se-resize shadow-md"
                  onPointerDown={(e) => onPointerDown(e, "resize")}
                  data-testid="editor-resize-handle"
                  title="Redimensionner"
                  />
                </div>
              )}
            </div>
        </div>

        <DialogFooter className="p-5 border-t border-border gap-2 flex-wrap">
          <Button variant="ghost" onClick={clearCustom} disabled={saving} data-testid="btn-pos-clear" className="text-muted-foreground">
            <X className="w-4 h-4 mr-1.5" /> Utiliser position 9-pos
          </Button>
          <div className="flex-1" />
          <Button variant="outline" onClick={onClose} data-testid="btn-pos-editor-cancel">
            Annuler
          </Button>
          <Button onClick={save} disabled={saving || loading} className="bg-brand text-white" data-testid="btn-pos-editor-save">
            {saving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Save className="w-4 h-4 mr-1.5" />}
            Enregistrer la position
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
