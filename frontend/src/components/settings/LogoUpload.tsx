import { Loader2, Upload } from 'lucide-react';
import { useUploadLogo } from '@/lib/api/organization';
import { toast } from '@/components/ui/use-toast';

export function LogoUpload() {
  const uploadMutation = useUploadLogo();

  const handleFile = (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      toast({
        title: 'That logo is too large',
        description: 'Pick an image under 2 MB.',
        tone: 'danger',
      });
      return;
    }
    uploadMutation.mutate(file);
  };

  return (
    <div>
      <input
        type="file"
        accept="image/png,image/jpeg,image/svg+xml"
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        className="hidden"
        id="logo-upload-input"
      />
      {/* Not a FormField target: this label is a styled clickable BUTTON trigger for the
          hidden file input (icon + "Upload Logo" text, cursor-pointer, border/hover chrome),
          not description text for a visible field - there is no hint/error/required concept
          here, and the htmlFor/id wiring is already correct. BrandingPage.tsx's sibling logo
          upload solves the identical hidden-input-trigger shape with a ref'd Button instead of
          a label at all - a structurally different pattern, out of this batch's scope either way. */}
      <label
        htmlFor="logo-upload-input"
        className="cursor-pointer inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-background-light"
      >
        {uploadMutation.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Upload className="h-4 w-4" />
        )}
        {uploadMutation.isPending ? 'Uploading…' : 'Upload Logo'}
      </label>
      {uploadMutation.isError && (
        <p className="text-sm text-danger-text mt-1">Upload failed. Please try again.</p>
      )}
      {uploadMutation.isSuccess && (
        <p className="text-sm text-success-text mt-1">Logo uploaded successfully.</p>
      )}
    </div>
  );
}
