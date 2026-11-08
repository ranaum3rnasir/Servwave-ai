/* =============================================================================
   VideoPreviewDialog - Storybook stories, phase 12 gap-closing pass.

   WHY THIS FILE EXISTS. Phase 12's story audit found two shipped primitives
   under components/ui with no co-located .stories.tsx at all - this one and
   AttachmentLightbox. Both are full-screen portalled overlays, which is
   almost certainly why they were skipped: neither renders in place, so
   neither shows up in a story panel the way an inline primitive does.
   That is a reason to write the story carefully, not a reason to leave the
   component undiscoverable (program plan corollary 2).

   NO cva() BLOCK AND NO Record<Key,string> LOOKUP. videoPreviewDialog has
   one prop that changes what renders (`url`) and one callback (`onClose`) -
   no variant axis at all - so storybook-completeness.test.ts has nothing to
   enforce here and this file is not trying to satisfy it. The coverage that
   matters is the two real STATES: `url: null` (renders nothing) and a live
   url (renders the portalled overlay).

   THE OVERLAY IS PORTALLED TO document.body, SO IT ESCAPES THE STORY CANVAS.
   `createPortal(..., document.body)` means the markup does not land inside
   Storybook's story root - it covers the whole preview iframe, `fixed
   inset-0`. That is the real shipped behaviour and these stories show it
   honestly rather than faking an inline variant that does not exist. Each
   story below therefore renders its own trigger and holds open/closed state,
   which is also how every real call site uses it (the caller keeps it
   mounted unconditionally and passes `selectedUrl ?? null`).

   THE VIDEO SOURCE IS A GENERATED data: URI, NOT A NETWORK URL. Storybook
   here runs with no fixtures server and CI builds it offline, so pointing at
   a remote sample would render a broken player in the exact story meant to
   document a working one. `TINY_MP4` below is a real, playable 1-frame MP4
   inlined as base64 - small enough to read as source, real enough that
   `<video controls>` renders its actual chrome.

   RELATIONSHIP TO AttachmentLightbox, STATED SO NOBODY "FIXES" IT BY
   ACCIDENT. AttachmentLightbox.tsx's own header records that it was built by
   synthesizing this file with StageDetailDialog's inline image overlay, and
   that `<AttachmentLightbox kind="video">` renders the same
   `<VideoPlayer>` this component does. So this component is a
   strict subset of that one and is a live duplicate-concept candidate - see
   that file's story for the superset. Consolidating them is NOT this file's
   job and is not attempted here; it is recorded as an observation for a
   future phase-12 structure pass.
   ============================================================================= */
import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { Button } from './button';
import { VideoPreviewDialog } from './VideoPreviewDialog';

/**
 * A real, playable 1-frame MP4 as a data: URI - see the header note on why
 * this is not a remote URL.
 */
const TINY_MP4 =
  'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAr1tZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbAAAAAFliIQA//70oPgUy+2qkrWH4b6TAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAAAAxliIQA//70oPgUy+2qkrWH4b6TAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAAAADQAAAAxtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAKAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB9HRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAKAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAEAAAAAAAJIbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAABAAVccAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABPW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAP1zdGJsAAAAmXN0c2QAAAAAAAAAAQAAAIlhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY//8AAAAzYXZjQwFkAAr/4QAaZ2QACqzZQnh5oQAAAwABAAADADwPFCmWAQAGaOvjyyLAAAAAEHBhc3AAAAABAAAAAQAAABhzdHRzAAAAAAAAAAEAAAABAAAEAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALGAAAAAQAAABRzdGNvAAAAAAAAAAEAAAAwAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2MC4zLjEwMA==';

/**
 * Every open-state story drives the overlay the way a real caller does:
 * keep it mounted, pass `url` or `null`.
 *
 * The state lives in this NAMED component rather than inline in each
 * story's `render` arrow, because a hook called inside an anonymous
 * `render` function violates `react-hooks/rules-of-hooks` - React only
 * guarantees hook identity inside a component or another hook, and an arrow
 * assigned to a `render` key is neither, even though Storybook renders it
 * as one.
 */
function VideoPreviewDemo({ label, note }: { label: string; note: string }) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [closedBy, setClosedBy] = React.useState('-');
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        onClick={() => {
          setClosedBy('-');
          setUrl(TINY_MP4);
        }}
      >
        {label}
      </Button>
      <span className="text-sm text-text-secondary">{note}</span>
      <span className="text-sm text-text-secondary">Last close: {closedBy}</span>
      <VideoPreviewDialog
        url={url}
        onClose={() => {
          setClosedBy('onClose fired');
          setUrl(null);
        }}
      />
    </div>
  );
}

const meta = {
  title: 'UI/VideoPreviewDialog',
  component: VideoPreviewDialog,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Full-screen portalled video preview. `url: null` renders nothing, so a caller keeps it mounted unconditionally and passes `selected?.url ?? null`. Closes on backdrop click, on the corner X, and on Escape. Portals to `document.body`, so it covers the whole preview frame rather than sitting inside the story canvas.',
      },
    },
  },
  argTypes: {
    url: {
      control: false,
      description:
        'The video source. `null` renders nothing at all - that is the closed state, and it is how every call site gates the overlay.',
    },
    onClose: {
      control: false,
      description:
        'Fired by the backdrop click, the corner X button, and the Escape key. The component holds no open state of its own.',
    },
  },
} satisfies Meta<typeof VideoPreviewDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The closed state: `url={null}` renders nothing at all. This is not a
 * degenerate case - it is how the component is kept mounted at every real
 * call site, so it is documented as a first-class state.
 */
export const Closed: Story = {
  args: {
    url: null,
    onClose: () => {},
  },
  render: (args) => (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-text-secondary">
        `url={'{null}'}` - the component returns `null` before it portals. Nothing renders, including no backdrop.
      </span>
      <VideoPreviewDialog {...args} />
    </div>
  ),
};

/**
 * The open state, driven the way a real caller drives it. Click Open to
 * portal the overlay over the whole preview frame; dismiss it with the
 * backdrop, the corner X, or the Escape key.
 */
export const Open: Story = {
  args: {
    url: null,
    onClose: () => {},
  },
  render: () => (
    <VideoPreviewDemo
      label="Open video preview"
      note="The overlay portals to `document.body`, so it covers this entire frame. Escape, the backdrop, and the corner X all close it."
    />
  ),
};

/**
 * The Escape-key path on its own. The listener is attached in a
 * `useEffect` keyed on `url`, so it is only bound while the overlay is
 * actually open - open this, then press Escape without touching the mouse.
 */
export const ClosesOnEscape: Story = {
  args: {
    url: null,
    onClose: () => {},
  },
  render: () => (
    <VideoPreviewDemo
      label="Open, then press Escape"
      note="The Escape listener is bound in a useEffect keyed on `url`, so it only exists while the overlay is open."
    />
  ),
};
