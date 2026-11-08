/**
 * prepareImageUpload - the accept/reject contract and the sizing maths.
 *
 * jsdom has no canvas encoder, so `prepareImageUpload` takes its documented
 * fallback path here and returns the untouched data URI. That is exactly the
 * behaviour worth pinning at this layer: a picture that cannot be downscaled
 * must still upload rather than hard-fail. The downscale itself is a browser
 * concern, covered by the pure helpers below plus manual checks in the app.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  ACCEPTED_IMAGE_MIMES,
  ImageUploadError,
  MAX_EDGE_PX,
  MAX_SOURCE_BYTES,
  dataUrlBytes,
  formatBytes,
  prepareImageUpload,
  scaleToFit,
} from '@/lib/image-upload'

const file = (bytes: number, type: string, name = 'photo.jpg') =>
  new File([new Uint8Array(bytes)], name, { type })

// jsdom never loads image resources, so a real `new Image()` here fires
// neither load nor error and the decode would sit out its full timeout. Stand
// in a decoder that fails immediately - the same branch a browser takes on an
// undecodable codec, and the one whose fallback these tests care about.
const RealImage = globalThis.Image
beforeAll(() => {
  vi.stubGlobal(
    'Image',
    class {
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.())
      }
    },
  )
})
afterAll(() => {
  vi.stubGlobal('Image', RealImage)
})

describe('size limits', () => {
  it('accepts a full-resolution phone photo - the case the old 512 KB cap rejected', async () => {
    const sixMegabytes = 6 * 1024 * 1024
    expect(sixMegabytes).toBeLessThanOrEqual(MAX_SOURCE_BYTES)
    await expect(prepareImageUpload(file(sixMegabytes, 'image/jpeg'))).resolves.toContain('data:')
  })

  it('rejects past the source cap, and says how big the file actually was', async () => {
    await expect(
      prepareImageUpload(file(MAX_SOURCE_BYTES + 1, 'image/jpeg')),
    ).rejects.toThrow(/10\.0 MB/)
  })

  it('rejects an unsupported type with copy safe to show a user', async () => {
    const err = await prepareImageUpload(file(1024, 'application/pdf', 'spec.pdf')).catch((e) => e)
    expect(err).toBeInstanceOf(ImageUploadError)
    expect(err.message).toMatch(/isn't supported/)
  })

  it('accepts HEIC, which phones produce by default', () => {
    expect(ACCEPTED_IMAGE_MIMES).toContain('image/heic')
  })
})

describe('SVG passthrough', () => {
  it('keeps vector uploads byte-identical instead of rasterizing them', async () => {
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', {
      type: 'image/svg+xml',
    })
    const out = await prepareImageUpload(svg)
    expect(out.startsWith('data:image/svg+xml')).toBe(true)
  })
})

describe('scaleToFit', () => {
  it('never upscales a picture that already fits', () => {
    expect(scaleToFit(800, 600)).toBe(1)
    expect(scaleToFit(MAX_EDGE_PX, 100)).toBe(1)
  })

  it('fits the longest edge, preserving aspect ratio either orientation', () => {
    expect(scaleToFit(3200, 2400)).toBeCloseTo(0.5)
    expect(scaleToFit(2400, 3200)).toBeCloseTo(0.5)
  })
})

describe('dataUrlBytes', () => {
  it('recovers the decoded size from a base64 payload', () => {
    // "hello" -> aGVsbG8= : 5 bytes.
    expect(dataUrlBytes('data:image/png;base64,aGVsbG8=')).toBe(5)
  })

  it('returns 0 for a string that is not a data URI', () => {
    expect(dataUrlBytes('https://example.com/a.png')).toBe(0)
  })
})

describe('formatBytes', () => {
  it('reads as KB under a megabyte and MB above it', () => {
    expect(formatBytes(480 * 1024)).toBe('480 KB')
    expect(formatBytes(6.5 * 1024 * 1024)).toBe('6.5 MB')
  })
})
