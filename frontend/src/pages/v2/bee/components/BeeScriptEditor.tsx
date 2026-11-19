import React, { useState, useRef, useEffect, useMemo } from 'react';
import { VARIABLES, VarDef, tokensIn, VAR_KEYS } from '@/lib/bee/agentFlow';
import { cn } from '@/lib/utils';
import { Braces, AlertCircle } from 'lucide-react';

export interface BeeScriptEditorProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
}

export const BeeScriptEditor: React.FC<BeeScriptEditorProps> = ({
  value,
  onChange,
  placeholder = 'What Bee should say...',
  rows = 3,
  className,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [cursorPos, setCursorPos] = useState<number>(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Find broken tokens
  const brokenTokens = useMemo(() => {
    const tokens = tokensIn(value || '');
    return tokens.filter((t) => !VAR_KEYS.has(t));
  }, [value]);

  // Find a suggestion for a broken token
  const getSuggestion = (token: string): VarDef => {
    const clean = (token || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    const found =
      VARIABLES.find((v) => v.key.toLowerCase().includes(clean)) ||
      VARIABLES.find((v) => clean.includes(v.group.toLowerCase())) ||
      VARIABLES[0];
    return found || {
      key: 'invoice.date',
      label: 'Invoice date',
      group: 'Invoice',
      example: 'March 6',
    };
  };

  const handleFixBrokenToken = (broken: string, replacement: VarDef) => {
    const regex = new RegExp(`\\{\\{\\s*${broken}\\s*\\}\\}`, 'g');
    onChange((value || '').replace(regex, `{{${replacement.key}}}`));
  };

  // Filtered variables for picker
  const filteredVars = useMemo(() => {
    const q = (pickerQuery || '').toLowerCase().trim();
    if (!q) return VARIABLES;
    return VARIABLES.filter(
      (v) =>
        v.label.toLowerCase().includes(q) ||
        v.key.toLowerCase().includes(q) ||
        v.group.toLowerCase().includes(q) ||
        v.example.toLowerCase().includes(q)
    );
  }, [pickerQuery]);

  // Group variables
  const groupedVars = useMemo(() => {
    const groups: Record<string, VarDef[]> = {};
    for (const v of filteredVars) {
      if (!groups[v.group]) {
        groups[v.group] = [];
      }
      const list = groups[v.group];
      if (list) {
        list.push(v);
      }
    }
    return groups;
  }, [filteredVars]);

  // Flattened for index navigation
  const flatVars = useMemo(() => {
    return filteredVars;
  }, [filteredVars]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [pickerQuery]);

  // Check if cursor is right after `{query`
  const checkPickerTrigger = (text: string, pos: number) => {
    const textBefore = text.slice(0, pos);
    const lastBrace = textBefore.lastIndexOf('{');
    if (lastBrace !== -1) {
      const afterBrace = textBefore.slice(lastBrace);
      if (!afterBrace.includes('}') && !afterBrace.includes('\n')) {
        const query = afterBrace.replace(/^\{+/, '');
        setPickerQuery(query);
        setPickerOpen(true);
        return;
      }
    }
    setPickerOpen(false);
  };

  const insertVariable = (varDef: VarDef) => {
    const textarea = textareaRef.current;
    let pos = cursorPos;
    if (textarea) {
      pos = textarea.selectionStart;
    }

    const current = value || '';
    const textBefore = current.slice(0, pos);
    const textAfter = current.slice(pos);

    const lastBrace = textBefore.lastIndexOf('{');
    let prefix = textBefore;
    if (lastBrace !== -1) {
      prefix = textBefore.slice(0, lastBrace);
    }

    const needsLeadingSpace = prefix.length > 0 && !prefix.endsWith(' ') && !prefix.endsWith('\n');
    const needsTrailingSpace = textAfter.length > 0 && !textAfter.startsWith(' ') && !textAfter.startsWith('\n');

    const tokenText = `${needsLeadingSpace ? ' ' : ''}{{${varDef.key}}}${needsTrailingSpace ? ' ' : ''}`;
    const newValue = prefix + tokenText + textAfter;

    onChange(newValue);
    setPickerOpen(false);
    setPickerQuery('');

    const newPos = prefix.length + tokenText.length;
    setCursorPos(newPos);

    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(newPos, newPos);
      }
    }, 10);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!pickerOpen || flatVars.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % flatVars.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + flatVars.length) % flatVars.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = flatVars[selectedIndex];
      if (item) {
        insertVariable(item);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setPickerOpen(false);
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const pos = e.target.selectionStart;
    onChange(val);
    setCursorPos(pos);
    checkPickerTrigger(val, pos);
  };

  const handleSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const pos = e.currentTarget.selectionStart;
    setCursorPos(pos);
    checkPickerTrigger(value || '', pos);
  };

  // Close picker on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Parse value into render segments for display mode
  const renderSegments = useMemo(() => {
    const segments: Array<{ text: string; isVar: boolean; isBroken?: boolean; label: string }> = [];
    const text = value || '';
    const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (match.index > last) {
        segments.push({ text: text.slice(last, match.index), isVar: false, label: '' });
      }
      const tokenKey = match[1] || '';
      const foundVar = VARIABLES.find((v) => v.key === tokenKey);
      if (foundVar) {
        segments.push({ text: tokenKey, isVar: true, isBroken: false, label: foundVar.label });
      } else {
        segments.push({ text: tokenKey, isVar: true, isBroken: true, label: `${tokenKey} ?` });
      }
      last = match.index + match[0].length;
    }
    if (last < text.length) {
      segments.push({ text: text.slice(last), isVar: false, label: '' });
    }
    return segments;
  }, [value]);

  return (
    <div ref={containerRef} className={cn('relative space-y-2', className)}>
      {/* Box Container */}
      <div
        className={cn(
          'border rounded-xl bg-white overflow-hidden transition-all',
          isEditing ? 'border-[#0F172A] ring-1 ring-[#0F172A]' : 'border-slate-300 hover:border-slate-400'
        )}
      >
        {/* Editor Area */}
        {isEditing ? (
          <div className="relative p-3.5 min-h-[72px]">
            <textarea
              ref={textareaRef}
              value={value || ''}
              onChange={handleTextareaChange}
              onSelect={handleSelect}
              onKeyDown={handleKeyDown}
              onBlur={() => {
                setTimeout(() => {
                  if (!pickerOpen) setIsEditing(false);
                }, 200);
              }}
              rows={rows}
              placeholder={placeholder}
              className="w-full text-[15px] leading-[1.9] font-sans text-[#0F172A] border-0 outline-none resize-none bg-transparent placeholder:text-slate-400 focus:ring-0 p-0"
              autoFocus
            />
          </div>
        ) : (
          <div
            onClick={() => {
              setIsEditing(true);
              setTimeout(() => {
                textareaRef.current?.focus();
              }, 20);
            }}
            className="p-[14px] px-[16px] min-h-[72px] text-[15px] leading-[1.9] text-[#0F172A] cursor-text select-text"
          >
            {(!value || value.trim().length === 0) ? (
              <span className="text-slate-400 italic">{placeholder}</span>
            ) : (
              renderSegments.map((seg, idx) => {
                if (!seg.isVar) {
                  return <span key={idx}>{seg.text}</span>;
                }
                if (seg.isBroken) {
                  return (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-1 mx-1 bg-[#FEF2F2] text-[#991B1B] border border-dashed border-[#F87171] rounded-[6px] px-[7px] text-[13px] font-bold leading-[22px] align-[1px]"
                    >
                      {seg.label} ?
                    </span>
                  );
                }
                return (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 mx-1 bg-[#EEF2FF] text-[#3730A3] border border-[#C7D2FE] rounded-[6px] px-[7px] text-[13px] font-semibold leading-[22px] align-[1px]"
                  >
                    {seg.label}
                  </span>
                );
              })
            )}
          </div>
        )}

        {/* Bottom Toolbar */}
        <div className="flex items-center justify-between gap-2 px-[10px] py-[8px] bg-[#F8FAFC] border-t border-[#E2E8F0] flex-wrap">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              setIsEditing(true);
              setPickerQuery('');
              setPickerOpen((prev) => !prev);
              setTimeout(() => textareaRef.current?.focus(), 20);
            }}
            className="h-[34px] px-3 rounded-[8px] border border-[#CBD5E1] bg-white hover:bg-slate-50 text-[#0F172A] text-[13px] font-semibold flex items-center gap-1.5 transition-colors"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1" />
            </svg>
            <span>Insert customer or job detail</span>
          </button>
          <span className="text-[12px] text-[#475569]">
            Tip: type <b className="font-mono text-[#0F172A]">{'{'}</b> to insert
          </span>
        </div>
      </div>

      {/* Variable Picker Dropdown Popover */}
      {pickerOpen && (
        <div
          className="absolute z-50 left-4 top-[80px] w-[380px] max-h-[340px] bg-white border border-[#E2E8F0] rounded-[14px] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-100"
          style={{ boxShadow: '0 12px 32px rgba(15,23,42,.14)' }}
        >
          {/* Header */}
          <div className="px-[14px] py-[10px] border-b border-[#E2E8F0] text-[12px] font-semibold text-[#475569] bg-white">
            {pickerQuery ? (
              <span>Matching &ldquo;{pickerQuery}&rdquo; · ↑↓ to move, Enter to insert</span>
            ) : (
              <span>Available details · ↑↓ to move, Enter to insert</span>
            )}
          </div>

          {/* List grouped */}
          <div className="overflow-y-auto p-1.5 flex-1 divide-y divide-slate-100">
            {flatVars.length === 0 ? (
              <div className="p-4 text-center text-[13px] text-[#475569]">
                No matching variables found
              </div>
            ) : (
              Object.entries(groupedVars).map(([group, vars]) => (
                <div key={group} className="p-1">
                  <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#475569]">
                    {group}
                  </div>
                  {vars.map((v) => {
                    const idx = flatVars.indexOf(v);
                    const isSelected = idx === selectedIndex;
                    return (
                      <button
                        key={v.key}
                        type="button"
                        onClick={() => insertVariable(v)}
                        onMouseEnter={() => setSelectedIndex(idx)}
                        className={cn(
                          'w-full flex items-center justify-between p-2.5 rounded-[8px] text-left border-none transition-colors',
                          isSelected
                            ? 'bg-[#F1F5F9]'
                            : 'bg-white hover:bg-[#F8FAFC]'
                        )}
                      >
                        <span className={cn('text-[14px] text-[#0F172A] truncate mr-2', isSelected ? 'font-bold' : 'font-semibold')}>
                          {v.label}
                        </span>
                        <span className="text-[12px] text-[#475569] shrink-0">e.g. {v.example}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Broken Variable Warning Banner */}
      {brokenTokens.map((token) => {
        const suggestion = getSuggestion(token);
        return (
          <div
            key={token}
            className="flex items-center justify-between gap-2.5 bg-[#FEF2F2] border border-[#FECACA] rounded-[10px] p-[10px] px-[12px] text-[13px] text-[#7F1D1D] animate-in fade-in duration-150"
          >
            <span className="font-bold">
              &ldquo;{token}&rdquo; isn&apos;t in your data.
            </span>
            <button
              type="button"
              onClick={() => handleFixBrokenToken(token, suggestion)}
              className="ml-auto h-8 px-2.5 rounded-[8px] border border-[#FCA5A5] bg-white hover:bg-red-50 text-[#7F1D1D] text-[12px] font-bold transition-colors shrink-0"
            >
              Replace with {suggestion.label}
            </button>
          </div>
        );
      })}
    </div>
  );
};

export default BeeScriptEditor;
