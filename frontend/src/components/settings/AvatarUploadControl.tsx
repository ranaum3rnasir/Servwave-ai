import { useRef } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSetAvatar, useDeleteAvatar } from '@/lib/api/users';
import { getInitials } from '@/lib/utils';
import { toast } from '@/components/ui/use-toast';

const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

interface AvatarUploadControlProps {
  /** Omitted → self (`/me/avatar`). Provided → admin-on-behalf-of (`/:id/avatar`). */
  userId?: string;
  avatarUrl: string | null | undefined;
  displayName: string;
  /** Called with the fresh avatar_url after a successful set/remove, so the caller can update
   *  whatever local copy it renders from (e.g. the cached auth user or an edit-dialog draft). */
  onChange?: (avatarUrl: string | null) => void;
}

/**
 * Profile-photo tile + upload/remove controls, shared between My Profile (self) and the admin
 * Users & Teams edit dialog (on-behalf-of). Picker is constrained to JPG/PNG only — narrower than
 * the server's JPG/PNG/WEBP allowlist — so a photo straight off an iPhone gets transcoded to JPEG
 * by the OS picker instead of arriving as HEIC (2026-08-04 plan, decision 6).
 */
export function AvatarUploadControl({ userId, avatarUrl, displayName, onChange }: AvatarUploadControlProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const setAvatar = useSetAvatar(userId);
  const deleteAvatar = useDeleteAvatar(userId);
  const busy = setAvatar.isPending || deleteAvatar.isPending;

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_AVATAR_BYTES) {
      toast({ title: 'Photo too large', description: 'Maximum size is 8MB.', variant: 'destructive' });
      return;
    }
    try {
      const result = await setAvatar.mutateAsync(file);
      onChange?.(result.avatar_url);
    } catch {
      // useSetAvatar's onError already toasted the failure.
    }
  };

  const handleRemove = async () => {
    try {
      const result = await deleteAvatar.mutateAsync();
      onChange?.(result.avatar_url);
    } catch {
      // useDeleteAvatar's onError already toasted the failure.
    }
  };

  return (
    <div className="flex items-center gap-4">
      <Avatar size="lg" ring="stack">
        {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} className="object-cover" />}
        <AvatarFallback tone="solid" className="text-sm font-semibold">
          {getInitials(displayName)}
        </AvatarFallback>
      </Avatar>
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png"
          className="hidden"
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {avatarUrl ? 'Replace photo' : 'Upload photo'}
        </Button>
        {avatarUrl && (
          <Button
            type="button"
            variant="ghost"
            tone="danger"
            size="sm"
            disabled={busy}
            onClick={() => void handleRemove()}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
