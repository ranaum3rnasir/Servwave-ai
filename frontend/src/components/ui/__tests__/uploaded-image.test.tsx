/**
 * UploadedImage - the "never crop a user's upload" contract.
 *
 * The bug this primitive replaces: every upload surface rendered the picture
 * with `object-cover` inside a fixed frame, so a square brand logo dropped
 * into the 2:1 category banner lost its bottom third (the ASSA ABLOY wordmark
 * in the reported case). The visible image must therefore always be
 * `object-contain`, and the optional blurred filler must stay out of the
 * accessibility tree so screen readers and `getByRole('img')` see one image.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { UploadedImage } from '@/components/ui/uploaded-image'

const SRC = 'data:image/png;base64,iVBORw0KGgo='

describe('UploadedImage', () => {
  it('contains the picture inside the frame instead of cropping it', () => {
    render(<UploadedImage src={SRC} alt="Adams Rite" />)
    const img = screen.getByAltText('Adams Rite')
    expect(img).toHaveClass('object-contain')
    expect(img).not.toHaveClass('object-cover')
    expect(img).toHaveAttribute('src', SRC)
  })

  it('passes frame classes to the wrapper and clips overflow', () => {
    const { container } = render(
      <UploadedImage src={SRC} className="h-14 w-14 rounded-lg ring-1 ring-border" />,
    )
    const frame = container.firstElementChild as HTMLElement
    expect(frame).toHaveClass('h-14', 'w-14', 'rounded-lg', 'ring-1', 'ring-border')
    expect(frame).toHaveClass('overflow-hidden')
  })

  it('renders no backdrop by default', () => {
    const { container } = render(<UploadedImage src={SRC} alt="logo" />)
    expect(container.querySelectorAll('img')).toHaveLength(1)
  })

  it('adds a decorative blurred backdrop, hidden from the a11y tree, when asked', () => {
    const { container } = render(<UploadedImage src={SRC} alt="hero" backdrop />)
    const imgs = Array.from(container.querySelectorAll('img'))
    expect(imgs).toHaveLength(2)

    const backdrop = imgs[0]
    expect(backdrop).toHaveAttribute('aria-hidden', 'true')
    expect(backdrop).toHaveClass('object-cover', 'blur-lg')

    // Only the real image is exposed - the filler must not double up.
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.getByRole('img')).toHaveClass('object-contain')
  })
})
