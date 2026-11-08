import { Users } from 'lucide-react';
import { Heading } from '@/components/ui/heading';

export default function UsersPage() {
  return (
    <div>
      <div className="rounded-xl bg-surface-light p-6 shadow-card border border-border">
        <Heading level={2} scale="lg" className="flex items-center gap-2">
          <Users className="h-5 w-5 shrink-0 text-primary" />
          Users
        </Heading>
        <p className="mt-2 text-sm text-text-secondary">
          User management coming soon.
        </p>
      </div>
    </div>
  );
}
