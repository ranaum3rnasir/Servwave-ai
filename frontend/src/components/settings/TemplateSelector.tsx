interface TemplateSelectorProps {
  value: string;
  onChange: (v: string) => void;
}

function AlphaClassicThumb() {
  return (
    <div className="w-[75px] h-[100px] rounded shadow-sm bg-surface-light border border-border overflow-hidden flex flex-col text-[4px]">
      <div className="bg-primary h-[18px] w-full flex items-center px-1.5">
        <div className="bg-on-fill/30 h-1 w-10 rounded-sm" />
      </div>
      <div className="p-1.5 flex flex-col gap-0.5 flex-1">
        <div className="bg-secondary h-0.5 w-full rounded-sm" />
        <div className="bg-neutral-border h-0.5 w-3/4 rounded-sm" />
        <div className="mt-1 bg-secondary h-0.5 w-full rounded-sm" />
        <div className="bg-neutral-border h-0.5 w-full rounded-sm" />
        <div className="bg-neutral-border h-0.5 w-2/3 rounded-sm" />
        <div className="mt-1 bg-secondary h-0.5 w-full rounded-sm" />
        <div className="bg-neutral-border h-0.5 w-full rounded-sm" />
        <div className="mt-auto border-t border-border pt-0.5">
          <div className="bg-neutral-border h-0.5 w-full rounded-sm" />
        </div>
      </div>
    </div>
  );
}

function CrmDefaultThumb() {
  return (
    <div className="w-[75px] h-[100px] rounded shadow-sm bg-surface-light border border-border overflow-hidden flex flex-col text-[4px]">
      <div className="bg-neutral-strong h-[14px] w-full flex items-center px-1.5 gap-1">
        <div className="bg-on-fill/40 h-1 w-6 rounded-sm" />
        <div className="ml-auto bg-on-fill/20 h-1 w-4 rounded-sm" />
      </div>
      <div className="p-1.5 flex flex-col gap-0.5 flex-1">
        <div className="bg-secondary h-0.5 w-1/2 rounded-sm" />
        <div className="bg-neutral-border h-0.5 w-3/4 rounded-sm" />
        <div className="mt-1 grid grid-cols-2 gap-0.5">
          <div className="bg-neutral-border h-0.5 rounded-sm" />
          <div className="bg-neutral-border h-0.5 rounded-sm" />
          <div className="bg-neutral-border h-0.5 rounded-sm" />
          <div className="bg-neutral-border h-0.5 rounded-sm" />
        </div>
        <div className="mt-1 bg-secondary h-0.5 w-full rounded-sm" />
        <div className="bg-neutral-border h-0.5 w-full rounded-sm" />
        <div className="bg-neutral-border h-0.5 w-2/3 rounded-sm" />
        <div className="mt-auto border-t border-border pt-0.5">
          <div className="bg-neutral-border h-0.5 w-full rounded-sm" />
        </div>
      </div>
    </div>
  );
}

const templates = [
  { key: 'alpha-classic', label: 'Classic', Thumb: AlphaClassicThumb },
  { key: 'crm-default', label: 'CRM Default', Thumb: CrmDefaultThumb },
];

export function TemplateSelector({ value, onChange }: TemplateSelectorProps) {
  return (
    <div className="flex gap-4">
      {templates.map(({ key, label, Thumb }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-colors ${
            value === key
              ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
              : 'border-border hover:border-text-secondary'
          }`}
        >
          <Thumb />
          <span className={`text-xs font-medium ${value === key ? 'text-primary' : 'text-text-secondary'}`}>{label}</span>
        </button>
      ))}
    </div>
  );
}
