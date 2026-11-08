import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import api from '@/lib/axios';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface EstimateNote {
  id: string;
  content: string;
  created_at: string;
  author?: { first_name: string; last_name: string } | null;
}

const fmt = (s: string) =>
  new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Notes card for the estimate workspace right rail — replaces the old detail-page
 * "Notes" tab. Self-contained: fetches and posts against the existing
 * `/api/estimates/:id/notes` endpoints (mocked in design mode).
 */
export function NotesCard({ estimateId }: { estimateId: string }) {
  const [content, setContent] = useState('');

  const { data: notes = [], refetch } = useQuery<EstimateNote[]>({
    queryKey: ['estimate-notes', estimateId],
    queryFn: async () => (await api.get(`/api/estimates/${estimateId}/notes`)).data.notes ?? [],
    enabled: !!estimateId,
  });

  const addNote = useMutation({
    mutationFn: async () => (await api.post(`/api/estimates/${estimateId}/notes`, { content })).data.note,
    onSuccess: () => {
      setContent('');
      void refetch();
    },
  });

  return (
    <div className="rounded-card border border-border bg-surface-light p-4 shadow-card">
      {/* eyebrow style, no matching Heading variant */}
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-text-secondary">
        <MessageSquare className="h-3.5 w-3.5" />
        Notes
      </h4>

      <div className="space-y-2">
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Add a note…"
          size="sm"
        />
        <Button
          size="sm"
          variant="solid" tone="business"
          disabled={!content.trim() || addNote.isPending}
          onClick={() => addNote.mutate()}
        >
          Add note
        </Button>
      </div>

      <div className="mt-3 space-y-2">
        {notes.length === 0 ? (
          <p className="text-sm text-text-secondary">No notes yet.</p>
        ) : (
          notes.map((n) => (
            <div key={n.id} className="rounded-md bg-primary-subtle px-2.5 py-1.5 text-sm">
              <p className="whitespace-pre-wrap text-text-primary">{n.content}</p>
              <p className="mt-0.5 text-xs text-text-secondary">
                {n.author ? `${n.author.first_name} ${n.author.last_name} · ` : ''}
                {fmt(n.created_at)}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
