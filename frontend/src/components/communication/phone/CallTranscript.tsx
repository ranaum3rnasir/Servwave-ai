// Structured call-transcript bubbles (SERV10X-65). Shared between the call
// drawer's short peek and the full-transcript reader - the only difference
// between those two surfaces is how many turns are passed in and whether
// clicking a turn seeks a recording.
//
// Sidedness is channel-based, never name-based: CTM's channel 1 is always the
// external party, channel 2 is always our side (verified live across inbound
// and outbound calls - see ingest.ts's transcriptTurnsOf header). The
// channel-2 *name* varies (a real user or a call group like "Dome OFFICE"),
// so matching on speaker name would misclassify sidedness on some calls.
import type { CallTranscriptTurn } from "@/lib/api/communication";
import { clock } from "@/components/communication/phone/shared";

function fmtTimecode(sec: number | null): string | null {
  if (sec == null || !Number.isFinite(sec)) return null;
  return clock(sec);
}

function speakerLabel(turn: CallTranscriptTurn): string {
  return turn.speaker.trim() || (turn.channel === 2 ? "Us" : "Caller");
}

export function CallTranscriptBubbles({
  turns,
  onTurnClick,
  className,
}: {
  turns: CallTranscriptTurn[];
  /** Reader-only: seek the docked recording to a turn's start. Omit for the peek. */
  onTurnClick?: (turn: CallTranscriptTurn) => void;
  className?: string;
}) {
  return (
    <div className={className ? `space-y-2 ${className}` : "space-y-2"}>
      {turns.map((turn, i) => {
        const ours = turn.channel === 2;
        const showSpeaker = i === 0 || speakerLabel(turn) !== speakerLabel(turns[i - 1]!);
        const timecode = fmtTimecode(turn.startSec);
        const Bubble = onTurnClick ? "button" : "div";
        return (
          <div key={i} className={`flex ${ours ? "justify-end" : "justify-start"}`}>
            <Bubble
              type={onTurnClick ? "button" : undefined}
              onClick={onTurnClick ? () => onTurnClick(turn) : undefined}
              className={[
                "max-w-[84%] rounded-card px-3 py-2 text-left text-[13px] leading-relaxed",
                ours ? "bg-primary/10 text-text-primary" : "bg-background-light text-text-primary",
                onTurnClick ? "cursor-pointer transition hover:opacity-80" : "",
              ].join(" ")}
            >
              {showSpeaker && (
                <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                  {speakerLabel(turn)}
                </p>
              )}
              <p>{turn.text}</p>
              {timecode && (
                <p className="mt-0.5 text-[11px] text-text-secondary">{timecode}</p>
              )}
            </Bubble>
          </div>
        );
      })}
    </div>
  );
}
