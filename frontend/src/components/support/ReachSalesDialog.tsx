import { useState } from 'react';
import { Send } from 'lucide-react';

import { useSendSalesRequest, salesRequestErrorMessage } from '@/lib/api/support';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { toast } from '@/ui-kit/components/ui/sonner';

export interface ReachSalesDialogProps {
  branch?: string;
  agentName?: string;
  mode?: 'sales' | 'support';
  initialSubject?: string;
  initialMessage?: string;
  onClose: () => void;
  onToast?: (message: string) => void;
}

/**
 * "Email support" / "Email sales" composer — a subject, preset question topics,
 * and a message textarea that POSTs to /api/support/sales-request and sends to info@servwave.com.
 */
export function ReachSalesDialog({
  branch = 'ServWave',
  agentName,
  mode,
  initialSubject,
  initialMessage,
  onClose,
  onToast,
}: ReachSalesDialogProps) {
  const isSupport = mode === 'support' || Boolean(agentName);

  const SALES_TOPICS = [
    {
      id: 'upgrade',
      label: 'Upgrade my plan',
      subject: `Upgrade my plan (${branch})`,
      message: `Hi, I'd like to upgrade our plan. Can you walk me through the options and pricing?`,
    },
    {
      id: 'numbers',
      label: 'Add phone numbers',
      subject: `Add phone numbers (${branch})`,
      message: `Hi, we'd like to add more phone numbers to our account. What's the pricing for additional local / toll-free numbers?`,
    },
    {
      id: 'port',
      label: 'Port a number',
      subject: `Port an existing number (${branch})`,
      message: `Hi, we'd like to port an existing number into ServWave Phone. Can you help with the porting process and timeline?`,
    },
    {
      id: 'limits',
      label: 'Raise call/text limits',
      subject: `Increase call / text limits (${branch})`,
      message: `Hi, we're approaching the calling/texting allowance included with our plan. Can we raise our limits or move to a better-fit plan?`,
    },
    {
      id: 'billing',
      label: 'Billing question',
      subject: `Billing question (${branch})`,
      message: `Hi, I have a question about our billing - could someone reach out?`,
    },
  ];

  const SUPPORT_TOPICS = [
    {
      id: 'upgrade',
      label: 'Upgrade my plan',
      subject: agentName ? `Upgrade plan to unlock ${agentName} (${branch})` : `Upgrade my plan (${branch})`,
      message: agentName
        ? `Hi, I'd like to enable the ${agentName} agent for our company. Can you walk me through the plan options and pricing?`
        : `Hi, I'd like to upgrade our plan. Can you walk me through the options and pricing?`,
    },
    {
      id: 'get_agent',
      label: `Get me ${agentName || 'agent'}`,
      subject: `Get me ${agentName || 'AI Agent'} (${branch})`,
      message: `Hi, I would like to get ${agentName || 'the AI agent'} enabled for our company. What are the next steps to get started?`,
    },
    {
      id: 'other',
      label: 'Other',
      subject: agentName ? `Support question - ${agentName} (${branch})` : `Support question (${branch})`,
      message: agentName
        ? `Hi, I have a question regarding the ${agentName} agent: `
        : `Hi, I have a question: `,
    },
  ];

  const TOPICS = isSupport ? SUPPORT_TOPICS : SALES_TOPICS;

  const defaultSub = initialSubject || (agentName ? `AI Agent inquiry - ${agentName} (${branch})` : `Phone plan question (${branch})`);
  const defaultMsg = initialMessage || (agentName ? `Hi, I'd like to learn more about the ${agentName} agent and how we can get it enabled for our company.` : '');

  const [subject, setSubject] = useState(defaultSub);
  const [message, setMessage] = useState(defaultMsg);
  const [topic, setTopic] = useState<string | null>(agentName ? 'upgrade' : null);
  const sendSalesRequest = useSendSalesRequest();

  function pickTopic(t: (typeof TOPICS)[number]) {
    setTopic(t.id);
    setSubject(t.subject);
    setMessage(t.message);
  }

  const handleNotify = (msg: string, isError = false) => {
    if (onToast) {
      onToast(msg);
    } else if (isError) {
      toast.error(msg);
    } else {
      toast.success(msg);
    }
  };

  const dialogTitle = isSupport ? 'Email support' : 'Email sales';
  const submitButtonText = isSupport ? 'Send to support' : 'Send to sales';
  const successToastText = isSupport
    ? "✓ Email sent to support - we'll reply to you shortly."
    : "✓ Email sent to sales - we'll reply to you shortly.";
  const placeholderText = isSupport
    ? "Add anything you'd like to discuss with the support team - inquiries, agent activation, questions…"
    : "Add anything you'd like to discuss with the sales team - pricing, add-on numbers, porting, contract questions…";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>We'll get the message and reply to you.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[13px]">
              <Label htmlFor="sales-subject" className="w-16 shrink-0">
                Subject
              </Label>
              <Input
                id="sales-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>

            <div>
              <p className="text-muted-foreground mb-1.5 text-[12px] font-semibold uppercase tracking-wide">
                Pick a question
              </p>
              <div className="flex flex-wrap gap-1.5">
                {TOPICS.map((t) => (
                  <Button
                    key={t.id}
                    size="sm"
                    variant={topic === t.id ? 'default' : 'outline'}
                    aria-pressed={topic === t.id}
                    onClick={() => pickTopic(t)}
                    className="rounded-full"
                  >
                    {t.label}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <Label htmlFor="sales-message">What would you like to ask?</Label>
              <Textarea
                id="sales-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                autoFocus
                className="mt-1"
                placeholder={placeholderText}
              />
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={sendSalesRequest.isPending}>
            Cancel
          </Button>
          <Button
            disabled={!message.trim() || sendSalesRequest.isPending}
            onClick={() => {
              sendSalesRequest.mutate(
                { subject, message, topic },
                {
                  onSuccess: () => {
                    handleNotify(successToastText);
                    onClose();
                  },
                  onError: (err) => handleNotify(salesRequestErrorMessage(err), true),
                },
              );
            }}
          >
            <Send className="mr-1.5 h-4 w-4" />
            {sendSalesRequest.isPending ? 'Sending…' : submitButtonText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ReachSalesDialog;

