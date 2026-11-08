/** Which kind of image is being requested — drives which results group renders it. */
export type AiImageMode = 'generate' | 'photo';

export interface AiImageResult {
  id: string;
  url: string;
  kind: AiImageMode;
  alt: string;
}

export interface AiImageRequest {
  description: string;
  mode: AiImageMode;
}

// Stand-in images. Replace this whole function body when wiring a real model/provider.
const MOCK_URLS: Record<AiImageMode, string[]> = {
  generate: [
    'https://placehold.co/400x400/E8EEF0/0C2D3A?text=AI+1',
    'https://placehold.co/400x400/E8EEF0/0C2D3A?text=AI+2',
    'https://placehold.co/400x400/E8EEF0/0C2D3A?text=AI+3',
    'https://placehold.co/400x400/E8EEF0/0C2D3A?text=AI+4',
  ],
  photo: [
    'https://placehold.co/400x400/123F50/FFFFFF?text=Photo+1',
    'https://placehold.co/400x400/123F50/FFFFFF?text=Photo+2',
    'https://placehold.co/400x400/123F50/FFFFFF?text=Photo+3',
    'https://placehold.co/400x400/123F50/FFFFFF?text=Photo+4',
  ],
};

/**
 * Phase-1 mock. Returns recommended images for a line description, tagged with the
 * requested mode. Simulates network latency so the UI exercises its loading state.
 * Connecting a real model later replaces only this function body.
 */
export function getAiImageSuggestions(req: AiImageRequest): Promise<AiImageResult[]> {
  const description = req.description.trim();
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (!description) {
        reject(new Error('AI image service unavailable'));
        return;
      }
      resolve(
        MOCK_URLS[req.mode].map((url, i) => ({
          id: `${req.mode}-${i}`,
          url,
          kind: req.mode,
          alt: `${req.mode === 'generate' ? 'Generated' : 'Photo'} suggestion for ${description}`,
        })),
      );
    }, 600);
  });
}
