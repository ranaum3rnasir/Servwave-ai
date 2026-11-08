import { useEffect, useState } from 'react';
import { Sparkles, Loader2, ImageIcon } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { UploadedImage } from '@/components/ui/uploaded-image';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/patterns/FormField';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getAiImageSuggestions,
  type AiImageResult,
  type AiImageMode,
} from '../lib/aiImageProvider';

export interface AiImagePanelProps {
  open: boolean;
  itemName: string;
  itemDetail: string;
  onApply: (imageUrl: string) => void;
  onClose: () => void;
}

export function AiImagePanel({ open, itemName, itemDetail, onApply, onClose }: AiImagePanelProps) {
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<AiImageResult[]>([]);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);

  // Seed the prompt + reset state each time the panel opens for a line.
  useEffect(() => {
    if (open) {
      setDescription([itemName, itemDetail].filter(Boolean).join('\n').trim());
      setResults([]);
      setSelectedUrl(null);
      setError(null);
    }
  }, [open, itemName, itemDetail]);

  async function handleGenerate() {
    setLoading(true);
    setError(null);
    setSelectedUrl(null);
    try {
      const [generated, photos] = await Promise.all([
        getAiImageSuggestions({ description, mode: 'generate' }),
        getAiImageSuggestions({ description, mode: 'photo' }),
      ]);
      setResults([...generated, ...photos]);
    } catch {
      setError('Could not fetch image suggestions. Try again.');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  const grid = (mode: AiImageMode) => {
    if (loading) {
      return (
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square w-full" />
          ))}
        </div>
      );
    }
    const items = results.filter((r) => r.kind === mode);
    if (!items.length) {
      return (
        <p className="flex flex-col items-center gap-2 py-10 text-sm text-text-secondary">
          <ImageIcon className="h-6 w-6" />
          Generate to see {mode === 'generate' ? 'AI illustrations' : 'real photos'}.
        </p>
      );
    }
    return (
      <div className="grid grid-cols-2 gap-3">
        {items.map((r) => (
          // Selectable image tile (wraps an <img>, border/ring communicates
          // selection) - a grid-tile click target, not Button-shaped. Deferred.
          <button
            key={r.id}
            type="button"
            aria-label={r.alt}
            onClick={() => setSelectedUrl(r.url)}
            className={`overflow-hidden rounded-card border transition ${
              selectedUrl === r.url
                ? 'border-ai-600 ring-2 ring-ai-600'
                : 'border-border hover:border-ai-500'
            }`}
          >
            <UploadedImage src={r.url} alt={r.alt} backdrop className="aspect-square w-full" />
          </button>
        ))}
      </div>
    );
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-4 sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-ai-600" />
            AI image suggestions
            <span className="rounded-full bg-ai-600/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ai-600">
              Preview
            </span>
          </SheetTitle>
          <SheetDescription>
            A preview of image suggestions — available with ServWave AI. These are example
            placeholders, not real generated images yet.
          </SheetDescription>
        </SheetHeader>

        {/* htmlFor is kept explicit rather than left to useId: "ai-desc" is
            the id this textarea already renders with, and FormField's own
            contract is that an explicit htmlFor wins. */}
        <FormField label="Description" htmlFor="ai-desc">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-[80px] resize-none"
          />
        </FormField>

        <Button variant="solid" tone="ai" onClick={handleGenerate} disabled={loading || !description.trim()}>
          {loading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
          {results.length ? 'Generate again' : 'Generate'}
        </Button>

        {error && (
          <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}{' '}
            {/* Inline text link inside error copy - Button's smallest rung still adds a
                fixed height/padding that would break the inline text flow, and no
                danger-toned link cell exists to reproduce the inherited red +
                always-on underline. Deferred. */}
            <button type="button" onClick={handleGenerate} className="font-semibold underline">
              Retry
            </button>
          </p>
        )}

        <Tabs defaultValue="generate" className="flex-1">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="generate">Example</TabsTrigger>
            <TabsTrigger value="photo">Example photos</TabsTrigger>
          </TabsList>
          <TabsContent value="generate" className="mt-3">{grid('generate')}</TabsContent>
          <TabsContent value="photo" className="mt-3">{grid('photo')}</TabsContent>
        </Tabs>

        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            variant="solid" tone="business"
            disabled={!selectedUrl}
            onClick={() => {
              if (selectedUrl) {
                onApply(selectedUrl);
                onClose();
              }
            }}
          >
            Use image
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
