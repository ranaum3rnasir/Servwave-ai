# Calendar Entries sit on the board without joining the assignment model

**Status:** accepted

A Calendar Entry (user-facing: "Event") renders on the scheduler alongside jobs and
walkthroughs - in the all-day strip when all-day, in a participant's member column when timed -
but it takes no part in the board's assignment model. Its participants are not crew, so
`deriveState`/`eventDangerState` never read it (an entry has no crew and would otherwise paint
red as state 4, "needs assignment", on every single entry), and `conflictedEventIds` skips it on
both axes: an entry neither reports a double-booking nor causes one. A dispatcher can therefore
put a real job on Dave at 2pm while a Calendar Entry naming Dave already sits at 2pm, and the
board will show no warning. That is the intended behaviour, not an oversight.

The alternative we rejected was making participation block availability, which is what every
consumer calendar does and what "invite Dave" leads people to expect. It fails on the cases the
feature exists for: a birthday with the whole team on it would mark every technician
double-booked and paint the board red, and - worse - the backend enforces conflicts on write
with a 409, so a birthday could reject a revenue job at the moment a dispatcher tries to
schedule it. We chose visibility without availability. The admitted cost is that "Dave is off
Thursday" is decorative: it appears in Dave's column and blocks nothing, and a dispatcher who
does not look will book over it. If that turns out to be the wrong trade, the fix is a
`blocks_availability` flag feeding the conflict pass - not a redefinition of participant.

This is also why participants are deliberately not called crew, invitees, or attendees, and why
there is no accept/decline: nothing about an entry is a question put to anyone. See
[[CONTEXT.md#participant-of-a-calendar-entry]] and [[CONTEXT.md#calendar-entry-user-facing-event]].
