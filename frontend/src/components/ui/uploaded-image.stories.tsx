/* =============================================================================
   UploadedImage - Storybook stories.

   The point of this primitive is a rendering failure that only shows up when
   the upload's aspect ratio does not match its frame, so every story below
   deliberately mismatches the two: a 1:1 source (the shape of a brand logo or
   a phone photo) inside the 2:1 category/group hero banner, and a 3:1 source
   inside a square item tile. The `object-cover` these sites used before would
   slice off a third of each; `object-contain` keeps them whole.

   ABOUT THE FIXTURES. Each source is an inline SVG data URI carrying a band
   flush against one edge - that band is exactly what a cropping render throws
   away first, so "is the band visible" IS the assertion these stories make by
   eye. They are drawn with plain rects and CSS named colours on purpose: a
   fixture is not UI chrome, and hex literals here would (correctly) trip the
   design-system token guard, which reads every file in the tree.
   ========================================================================== */
import type { Meta, StoryObj } from '@storybook/react'

import { UploadedImage } from '@/components/ui/uploaded-image'

/** 1:1 source - the "logo dropped into a wide banner" case from the bug report. */
const SQUARE = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
     <rect width="200" height="200" fill="navy"/>
     <circle cx="100" cy="80" r="46" fill="white"/>
     <rect y="150" width="200" height="50" fill="white"/>
   </svg>`,
)}`

/** 3:1 source - the "wide banner dropped into a square tile" case. */
const WIDE = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200">
     <rect width="600" height="200" fill="darkgreen"/>
     <rect width="40" height="200" fill="white"/>
     <rect x="560" width="40" height="200" fill="white"/>
   </svg>`,
)}`

const meta = {
  title: 'UI/UploadedImage',
  component: UploadedImage,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof UploadedImage>

export default meta
type Story = StoryObj<typeof meta>

/** Square upload, square frame - nothing to letterbox. */
export const Default: Story = {
  args: {
    src: SQUARE,
    alt: 'Brand logo',
    radius: 'lg',
    edge: 'ring',
    className: 'h-24 w-24',
  },
}

/** The reported bug's shape: a square logo in the 2:1 hero banner. */
export const HeroBannerWithBackdrop: Story = {
  args: {
    src: SQUARE,
    alt: 'Category hero',
    backdrop: true,
    radius: 'lg',
    edge: 'ring',
    className: 'aspect-[2/1] w-[420px]',
  },
}

/** Same frame without the filler - plain letterboxing on the token surface. */
export const HeroBannerNoBackdrop: Story = {
  args: {
    src: SQUARE,
    alt: 'Category hero',
    radius: 'lg',
    edge: 'ring',
    className: 'aspect-[2/1] w-[420px]',
  },
}

/** The inverse mismatch: a 3:1 banner inside the square item preview tile. */
export const WideSourceInSquareTile: Story = {
  args: {
    src: WIDE,
    alt: 'Item preview',
    backdrop: true,
    radius: 'lg',
    edge: 'ring',
    className: 'aspect-square w-[220px]',
  },
}

/** List-row size, the smallest frame any of these render at. */
export const Thumbnail: Story = {
  args: {
    src: WIDE,
    alt: 'Item thumbnail',
    radius: 'sm',
    edge: 'ring',
    className: 'h-9 w-9',
  },
}

/** Every `edge` value side by side - the closed vocabulary in one frame. */
export const EdgeTreatments: Story = {
  args: { src: SQUARE, alt: 'Edge treatments', radius: 'md', className: 'h-16 w-16' },
  render: (args) => (
    <div className="flex items-center gap-4">
      <UploadedImage {...args} edge="none" />
      <UploadedImage {...args} edge="ring" />
      <UploadedImage {...args} edge="border" />
    </div>
  ),
}
