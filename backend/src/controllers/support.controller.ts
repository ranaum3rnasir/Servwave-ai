import { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { SALES_CONTACT_EMAIL, sendSalesContactEmail, dispatchFailureStatus } from '../lib/email';
import { SALES_TOPICS } from '../lib/sales-request-email';

/**
 * The Phone header's "Reach sales" composer.
 *
 * Neither end of the message is named by the client. The destination is owned
 * by the server (lib/email.ts SALES_CONTACT_EMAIL) so an authenticated user
 * cannot aim our verified sending domain at an address of their choosing, and
 * the reply address is the sender's own login email, so a reply goes to the
 * account that actually wrote in rather than wherever the request asked.
 *
 * The identity in the email - org, plan, person, role - is likewise not read
 * from the body. It comes off the authenticated session and the org row, so it
 * describes who actually sent the message rather than who they claimed to be.
 * `topic` IS from the body, but it is an enum of the composer's own presets, so
 * the worst a crafted request can do is mislabel its own subject line.
 *
 * This send is NOT subject to the org's outgoing-email kill switch. That switch
 * stops an org speaking to its own customers under its own name; this message
 * is addressed to ServWave, in the platform's voice. Because email is off by
 * default for every new org, gating it meant the orgs most likely to need sales
 * were the ones that could not reach it. See bypassOrgSendingGate in
 * lib/email.ts.
 */
export const salesRequestSchema = z.object({
  subject: z.string().trim().min(1, 'Subject is required').max(200),
  message: z.string().trim().min(1, 'Message is required').max(10_000),
  topic: z.enum(SALES_TOPICS).nullish(),
});

export async function createSalesRequest(req: Request, res: Response): Promise<void> {
  const { subject, message, topic } = req.body as z.infer<typeof salesRequestSchema>;
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const senderName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || null;

  try {
    const result = await sendSalesContactEmail({
      organizationId: user.organization_id,
      to: SALES_CONTACT_EMAIL,
      subject,
      message,
      // The composer asks for a subject and a question, nothing else. Replies go
      // to the address they signed in with.
      replyTo: user.email,
      topic: topic ?? null,
      sender: {
        id: user.id,
        name: senderName,
        email: user.email,
        // The custom role's key when there is one - "Admin" on a user whose real
        // role is a custom "Office manager" would be a lie to whoever replies.
        role: user.custom_role?.key ?? user.role,
      },
    });

    if (result.status !== 'sent') {
      // The composer promises the owner their message went out. When it did not,
      // say so rather than toasting a success the inbox will never see.
      //
      // WHICH failure decides the wording, via the same dispatchFailureStatus
      // the PO, stage-pickup and WhatsApp-email senders use. A 409 is a
      // deliberate, permanent block - retrying repeats it exactly - so it must
      // not be dressed up as a transient hiccup. Getting this wrong is what
      // made the kill-switch outage read as "try again shortly" while every
      // retry failed identically.
      const status = dispatchFailureStatus(result);
      res.status(status).json({
        error:
          status === 409
            ? `We couldn't deliver your message to our sales inbox. Please email ${SALES_CONTACT_EMAIL} directly.`
            : "We couldn't send your message right now. Please try again shortly.",
      });
      return;
    }

    res.json({ status: 'sent', to: SALES_CONTACT_EMAIL });
  } catch (err) {
    logger.error('Failed to send sales request:', err);
    res.status(502).json({
      error: "We couldn't send your message right now. Please try again shortly.",
    });
  }
}
