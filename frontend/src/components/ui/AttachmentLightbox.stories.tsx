/* =============================================================================
   AttachmentLightbox - Storybook stories, phase 12 gap-closing pass.

   WHY THIS FILE EXISTS. Phase 12's story audit found exactly two shipped
   primitives under components/ui with no co-located .stories.tsx - this one
   and VideoPreviewDialog. Both are full-screen portalled overlays, which is
   almost certainly why they were skipped: neither renders in place, so
   neither appears in a story panel the way an inline primitive does. That
   makes the story harder to write, not optional to write (program plan
   corollary 2 - a variant that exists in code but not in Storybook cannot be
   discovered by a designer, so it does not exist).

   THE VARIANT AXIS IS `kind`, AND IT IS NOT A cva() BLOCK. AttachmentLightbox
   has no cva() call and no `Record<Key, string>` class lookup - `kind` picks
   an ELEMENT (`<img>` vs `<VideoPlayer>`), not a class string -
   so storybook-completeness.test.ts has nothing to walk here and this file is
   not written to satisfy that guard. Both values still get their own story
   below, because they are the two real shapes a caller can render:

     kind: 'image' (default)  -> KindImage
     kind: 'video'            -> KindVideo

   THE FOOTER IS A THIRD SHAPE, DRIVEN BY THREE OPTIONAL PROPS. `hasFooter`
   is `Boolean(caption || uploadedBy || uploadedAt)`, so the footer is present
   or absent rather than being its own prop - WithoutFooter and WithFullFooter
   pin both ends of that, and CaptionOnly pins the common partial case.

   ASSETS ARE INLINE data: URIs, NOT NETWORK URLS. Storybook here runs with no
   fixtures server and CI builds it offline, so a remote sample would render a
   broken image in the exact story meant to document a working one. The SVG
   below is readable as source; the MP4 is the same 1-frame clip
   VideoPreviewDialog.stories.tsx uses, kept identical on purpose so the two
   files' video stories are visually comparable.

   RELATIONSHIP TO VideoPreviewDialog. This component's own header records
   that it was built by synthesizing VideoPreviewDialog with
   StageDetailDialog's inline image overlay, and `kind="video"` renders the
   same `<VideoPlayer>` that component does - so VideoPreviewDialog
   is a strict subset of this one and the two are a live duplicate-concept
   candidate. Consolidating them is NOT this file's job and is not attempted
   here; it is recorded so a future structure pass finds it already measured.
   ============================================================================= */
import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { AttachmentLightbox } from './AttachmentLightbox';
import { Button } from './button';

/**
 * A real 320x200 PNG as a data: URI - see the header note on why this is not
 * a remote URL.
 *
 * DELIBERATELY A BASE64 PNG RATHER THAN THE READABLE INLINE SVG THIS STARTED
 * AS. An SVG fixture is nicer to read, but a literal one in a `.tsx` file is
 * scanned by two repo guards and breaks both: its `fill` colours are raw
 * 6-digit hex (tokens-guard's zero-tolerance rule plus its whole-tree
 * ratchet, which this pushed 66 -> 71), and the SVG presentation attributes
 * controlling typography and glyph alignment are hyphenated words, so
 * unresolved-classes-guard tokenises them as if they were Tailwind classes.
 * Both hazards are described in prose here rather than quoted, because
 * quoting either one in this comment reproduces the very failure it
 * describes - the guard reads comment text too. Neither guard is wrong -
 * they read source text and cannot know this span is an image fixture. Base64
 * has neither hazard, so the fixture pays the readability cost instead of the
 * guards paying a carve-out.
 */
const SAMPLE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAABzklEQVR42u3TMQ0AIAwAwTphZsYSEnDBigNMIA8RTCWXnIJPPkptQFIhARgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBAwMGBgMDBgYMDAYGDAwYGDAwGBgwMGBgMLAKYGDAwICBwcCAgQEDAwYGAwMGBgwMBgYMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIHBwICBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBgYMDAYGDAwICBAQODgQEDAwYGAwMGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwPPA699gKQMDAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAy/DNzHBJIyMBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBAwMGBgMDBgYMDAYGDAwYGDAwGBgwMGBgMLAKYGDAwICBwcCAgQEDAwYGAwMGBgwMBgYMDBgYMDAYGDAwYGDAwPCFC7z8dyHVisqYAAAAAElFTkSuQmCC';

/** The same 1-frame MP4 VideoPreviewDialog.stories.tsx uses, kept identical on purpose. */
const SAMPLE_VIDEO =
  'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAr1tZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbAAAAAFliIQA//70oPgUy+2qkrWH4b6TAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAAAAxliIQA//70oPgUy+2qkrWH4b6TAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAAAADQAAAAxtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAKAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB9HRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAKAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAEAAAAAAAJIbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAABAAVccAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABPW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAP1zdGJsAAAAmXN0c2QAAAAAAAAAAQAAAIlhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY//8AAAAzYXZjQwFkAAr/4QAaZ2QACqzZQnh5oQAAAwABAAADADwPFCmWAQAGaOvjyyLAAAAAEHBhc3AAAAABAAAAAQAAABhzdHRzAAAAAAAAAAEAAAABAAAEAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALGAAAAAQAAABRzdGNvAAAAAAAAAAEAAAAwAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2MC4zLjEwMA==';

/**
 * Every story drives the overlay the way a real caller does: keep it mounted
 * unconditionally, pass `url` or `null`. Rendering it already-open would
 * portal a `fixed inset-0` layer over the docs page itself.
 */
function LightboxDemo({
  label,
  ...props
}: { label: string } & Omit<React.ComponentProps<typeof AttachmentLightbox>, 'url' | 'onClose'> & {
    src: string;
  }) {
  const { src, ...rest } = props;
  const [url, setUrl] = React.useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-2">
      <Button onClick={() => setUrl(src)}>{label}</Button>
      <span className="text-sm text-text-secondary">
        Portals to `document.body`, so it covers this whole frame. Backdrop click, the corner X, and Escape all close it.
      </span>
      <AttachmentLightbox {...rest} url={url} onClose={() => setUrl(null)} />
    </div>
  );
}

const meta = {
  title: 'UI/AttachmentLightbox',
  component: AttachmentLightbox,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          "Full-screen portalled attachment viewer. `url: null` renders nothing, so a caller keeps it mounted and passes `selected?.url ?? null`. `kind` switches between an `<img>` and a `<VideoPlayer>`, which falls back to a download affordance when the browser cannot play the file. The caption/uploader/date footer appears only when at least one of those three props is set.",
      },
    },
  },
  argTypes: {
    url: {
      control: false,
      description: 'The asset source. `null` renders nothing at all - that is the closed state.',
    },
    kind: {
      control: { type: 'inline-radio' },
      options: ['image', 'video'],
      description:
        "`'image'` (the default) renders an `<img>`; `'video'` renders `<VideoPlayer>`. Every pre-existing caller passes images only, which is why the default is backward-compatible.",
    },
    caption: {
      control: 'text',
      description: 'Footer line 1, bolded. Also used as the `<img alt>` text when `kind` is `image`.',
    },
    uploadedBy: { control: 'text', description: 'Footer line 2, first half.' },
    uploadedAt: {
      control: 'text',
      description: 'Footer line 2, second half. Rendered through `new Date(...).toLocaleString()`.',
    },
    onClose: {
      control: false,
      description: 'Fired by the backdrop click, the corner X, and the Escape key.',
    },
    onDelete: {
      control: false,
      description:
        'Optional. Supplying it reveals a delete control beside the close X; omitting it renders the overlay exactly as it did before the prop existed. The component does NOT confirm and does NOT close itself - the caller owns both, because only the caller knows its own confirm wording and whether the request actually succeeded.',
    },
    deleting: {
      control: 'boolean',
      description: 'Disables the delete control while a delete is in flight.',
    },
  },
} satisfies Meta<typeof AttachmentLightbox>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The closed state: `url={null}` renders nothing at all. Documented as a
 * first-class state because it is how the component sits at every real call
 * site between openings.
 */
export const Closed: Story = {
  args: { url: null, onClose: () => {} },
  render: (args) => (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-text-secondary">
        `url={'{null}'}` - the component returns before it portals. Nothing renders, not even a backdrop.
      </span>
      <AttachmentLightbox {...args} />
    </div>
  ),
};

/** `kind="image"` - the default, and the only shape every pre-existing caller uses. */
export const KindImage: Story = {
  args: { url: null, kind: 'image', caption: 'Condenser coil, north unit', onClose: () => {} },
  render: (args) => (
    <LightboxDemo label="Open image" src={SAMPLE_IMAGE} kind="image" caption={args.caption} />
  ),
};

/** `kind="video"` - renders `<VideoPlayer>`, mirroring VideoPreviewDialog. */
export const KindVideo: Story = {
  args: { url: null, kind: 'video', caption: 'Walkthrough clip', onClose: () => {} },
  render: (args) => (
    <LightboxDemo label="Open video" src={SAMPLE_VIDEO} kind="video" caption={args.caption} />
  ),
};

/**
 * No `caption`, no `uploadedBy`, no `uploadedAt` - so `hasFooter` is false and
 * the footer block is absent entirely. The bare asset plus its close button.
 */
export const WithoutFooter: Story = {
  args: { url: null, onClose: () => {} },
  render: () => <LightboxDemo label="Open without footer" src={SAMPLE_IMAGE} />,
};

/** Only `caption` set - the common partial case, footer renders one line. */
export const CaptionOnly: Story = {
  args: { url: null, caption: 'Return air plenum, before cleaning', onClose: () => {} },
  render: () => (
    <LightboxDemo
      label="Open with caption only"
      src={SAMPLE_IMAGE}
      caption="Return air plenum, before cleaning"
    />
  ),
};

/**
 * All three footer props set - both footer lines render, with the ` - `
 * separator between uploader and date.
 */
export const WithFullFooter: Story = {
  args: {
    url: null,
    caption: 'Condenser coil, north unit',
    uploadedBy: 'Dana Whitfield',
    uploadedAt: '2026-07-14T16:20:00.000Z',
    onClose: () => {},
  },
  render: () => (
    <LightboxDemo
      label="Open with full footer"
      src={SAMPLE_IMAGE}
      caption="Condenser coil, north unit"
      uploadedBy="Dana Whitfield"
      uploadedAt="2026-07-14T16:20:00.000Z"
    />
  ),
};

/**
 * `onDelete` supplied - a delete control appears to the LEFT of the close X, never in the corner
 * the X has always owned, so muscle memory for "dismiss this" cannot land on a destructive action.
 *
 * This story also demonstrates the split the component deliberately enforces: the lightbox only
 * FIRES `onDelete`. Confirming, deleting, and closing all belong to the caller, which is why the
 * demo below closes itself inside its own handler. A lightbox that closed on click would dismiss
 * the viewer even when the request went on to fail.
 */
export const WithDelete: Story = {
  args: { url: null, caption: 'Condenser coil, north unit', onClose: () => {} },
  render: () => {
    function DeletableDemo() {
      const [url, setUrl] = React.useState<string | null>(null);
      const [log, setLog] = React.useState<string | null>(null);
      return (
        <div className="flex flex-col items-start gap-2">
          <Button onClick={() => { setLog(null); setUrl(SAMPLE_IMAGE); }}>Open with delete</Button>
          <span className="text-sm text-text-secondary">
            The trash control sits beside the X. Deleting here stands in for the caller's own
            confirm-then-delete, then closes the overlay.
          </span>
          {log && <span className="text-sm text-text-secondary">{log}</span>}
          <AttachmentLightbox
            url={url}
            caption="Condenser coil, north unit"
            uploadedBy="Dana Whitfield"
            uploadedAt="2026-07-14T16:20:00.000Z"
            onDelete={() => {
              setLog('Caller handled the delete and closed the overlay.');
              setUrl(null);
            }}
            onClose={() => setUrl(null)}
          />
        </div>
      );
    }
    return <DeletableDemo />;
  },
};

/** `deleting` - the control is disabled while the caller's request is in flight. */
export const DeleteInFlight: Story = {
  args: { url: null, caption: 'Condenser coil, north unit', deleting: true, onClose: () => {} },
  render: () => (
    <LightboxDemo
      label="Open mid-delete"
      src={SAMPLE_IMAGE}
      caption="Condenser coil, north unit"
      onDelete={() => {}}
      deleting
    />
  ),
};
