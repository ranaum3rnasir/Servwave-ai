import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, ArrowLeft } from 'lucide-react';

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  showBack?: boolean;
}

export function Breadcrumb({ items, showBack = true }: BreadcrumbProps) {
  const navigate = useNavigate();

  return (
    <nav className="flex items-center gap-1.5 text-sm mb-4">
      {showBack && (
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="mr-1.5 p-1 -ml-1 rounded-md text-text-secondary hover:text-primary hover:bg-primary/10 transition-colors"
          aria-label="Go back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      )}
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-text-secondary" />}
            {isLast || !item.href ? (
              <span className={isLast ? 'font-medium text-text-primary' : 'text-text-secondary'}>
                {item.label}
              </span>
            ) : (
              <Link
                to={item.href}
                className="text-text-secondary hover:text-primary transition-colors"
              >
                {item.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
