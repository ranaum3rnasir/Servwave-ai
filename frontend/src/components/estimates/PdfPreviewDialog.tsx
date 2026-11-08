import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle, Download, Loader2, RefreshCw } from 'lucide-react';
import { getAccessToken } from '@/lib/supabase';

interface PdfPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pdfUrl: string;
  downloadFilename: string;
  title?: string;
}

export async function fetchPdf(pdfUrl: string): Promise<Blob> {
  const token = getAccessToken();
  // Resolve relative paths against VITE_API_URL so the request hits the
  // backend on Render in production. A bare `/api/...` would otherwise resolve
  // against the Vercel origin, which serves the SPA fallback (200 + HTML) for
  // any unknown path — yielding a blob with text/html that the iframe renders
  // as a blank page.
  const url = /^https?:\/\//.test(pdfUrl)
    ? pdfUrl
    : `${import.meta.env.VITE_API_URL || ''}${pdfUrl}`;
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`${res.status}`);
  // Defense-in-depth: if a misroute returns 200 with non-PDF content (e.g. an
  // SPA fallback), surface the error instead of rendering a blank iframe.
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/pdf')) throw new Error('invalid-content');
  return res.blob();
}

export function PdfPreviewDialog({
  open,
  onOpenChange,
  pdfUrl,
  downloadFilename,
  title = 'Estimate Preview',
}: PdfPreviewDialogProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    let revoked = false;
    setLoading(true);
    setError(null);
    fetchPdf(pdfUrl)
      .then((blob) => {
        if (revoked) return;
        setBlobUrl(URL.createObjectURL(blob));
      })
      .catch((err: unknown) => {
        if (revoked) return;
        const code = err instanceof Error ? err.message : 'unknown';
        setError(
          code === '401' || code === '403'
            ? 'Session expired — please refresh the page and try again.'
            : code === '404'
              ? 'PDF not found for this estimate.'
              : code === 'invalid-content'
                ? 'PDF response was malformed. Please try again or contact support.'
                : `Could not load PDF (${code}). Please try again.`,
        );
      })
      .finally(() => setLoading(false));
    return () => { revoked = true; };
  };

  useEffect(() => {
    if (!open) return;
    const cleanup = load();
    return () => {
      cleanup();
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setError(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pdfUrl]);

  const handleDownload = () => {
    if (!blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = downloadFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[90vh] flex flex-col p-0">
        <DialogHeader className="pl-6 pr-14 py-4 border-b flex-row items-center justify-between">
          <DialogTitle>{title}</DialogTitle>
          <Button variant="outline" size="sm" onClick={handleDownload} disabled={!blobUrl}>
            <Download className="mr-2 h-4 w-4" />Download
          </Button>
        </DialogHeader>
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-text-secondary" />
          </div>
        ) : error ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
            <AlertCircle className="h-8 w-8 text-danger" />
            <p className="text-sm text-text-secondary max-w-sm">{error}</p>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="mr-2 h-4 w-4" />Try again
            </Button>
          </div>
        ) : blobUrl ? (
          <iframe
            src={blobUrl}
            className="flex-1 w-full border-0"
            title={title}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
