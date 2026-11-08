// SERV10X-65 PR3: the shared bubble list rendered by both the drawer peek and
// the full-transcript reader. Sidedness is channel-based (channel 2 = us),
// never derived from the speaker name, which varies call to call.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CallTranscriptBubbles } from "../CallTranscript";
import type { CallTranscriptTurn } from "@/lib/api/communication";

const TURNS: CallTranscriptTurn[] = [
  { speaker: "PRINCETON NJ", text: "Can you hear me?", channel: 1, startSec: 0.5, endSec: 2.1 },
  { speaker: "Art Nakamura", text: "Yes, go ahead.", channel: 2, startSec: 2.4, endSec: 3.9 },
];

describe("CallTranscriptBubbles", () => {
  it("renders each turn's text and speaker label", () => {
    render(<CallTranscriptBubbles turns={TURNS} />);
    expect(screen.getByText("Can you hear me?")).toBeInTheDocument();
    expect(screen.getByText("Yes, go ahead.")).toBeInTheDocument();
    expect(screen.getByText("PRINCETON NJ")).toBeInTheDocument();
    expect(screen.getByText("Art Nakamura")).toBeInTheDocument();
  });

  it("handles a one-sided transcript (single channel only)", () => {
    render(<CallTranscriptBubbles turns={[TURNS[0]!]} />);
    expect(screen.getByText("Can you hear me?")).toBeInTheDocument();
  });

  it("is not clickable (no onTurnClick) in the peek", () => {
    render(<CallTranscriptBubbles turns={TURNS} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("calls onTurnClick with the clicked turn when provided (reader mode)", () => {
    const onTurnClick = vi.fn();
    render(<CallTranscriptBubbles turns={TURNS} onTurnClick={onTurnClick} />);
    fireEvent.click(screen.getByText("Yes, go ahead."));
    expect(onTurnClick).toHaveBeenCalledWith(TURNS[1]);
  });
});
