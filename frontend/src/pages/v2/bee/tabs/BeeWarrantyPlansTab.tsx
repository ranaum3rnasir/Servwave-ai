import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeeStore } from '@/stores/beeStore';
import { useOrganization } from '@/lib/api/organization';
import { useConfirm } from '@/hooks/useConfirm';
import { BeePlanItem, BeePlanFileItem, JobTypeWarrantyItem } from '@/lib/api/bee';
import { 
  Plus, 
  Paperclip, 
  Upload, 
  Trash2, 
  Check, 
  FileText, 
  ShieldCheck, 
  Clock, 
  ExternalLink,
  X,
  AlertCircle
} from 'lucide-react';
import { Heading } from '@/ui-kit/components/ui/heading';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui-kit/components/ui/table';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { cn } from '@/lib/utils';

const DUR_PRESETS = ['30 days', '60 days', '90 days', '6 months', '12 months', '2 years', '5 years'];
const UNITS = ['days', 'weeks', 'months', 'years'];
const PER_OPTS = [
  { value: 'job', label: 'Whole job (flat)' },
  { value: 'door', label: 'Per door' },
  { value: 'unit', label: 'Per unit' },
  { value: 'item', label: 'Per item' },
  { value: 'visit', label: 'Per visit' },
  { value: 'location', label: 'Per location' },
];

const money = (n: number | string) => {
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (isNaN(num)) return '$-';
  return '$' + num.toLocaleString('en-US', {
    minimumFractionDigits: num % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  });
};

const priceText = (p: { price: number | string; per?: string; billing?: string; billing_interval?: string }) => {
  const m = money(p.price);
  const perStr = p.per && p.per !== 'job' ? ` / ${p.per}` : '';
  const b = p.billing || p.billing_interval || '';
  const billStr = b.toLowerCase() === 'yearly' ? ' / yr' : b.toLowerCase() === 'monthly' ? ' / mo' : '';
  return `${m}${perStr}${billStr}`;
};

const fileSize = (b?: number) => {
  if (!b) return '0 KB';
  return b < 1024 * 1024
    ? Math.max(1, Math.round(b / 1024)) + ' KB'
    : (b / (1024 * 1024)).toFixed(1) + ' MB';
};

export const BeeWarrantyPlansTab: React.FC = () => {
  const { 
    plans, 
    loadPlans, 
    createPlan, 
    updatePlan, 
    deletePlan, 
    jobTypeWarranties, 
    loadJobTypeWarranties, 
    saveJobTypeWarranties,
  } = useBeeStore();

  const navigate = useNavigate();
  const { data: org } = useOrganization();
  const { confirm, confirmDialog } = useConfirm();

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Local state for Job Type Warranties editing
  const [localJobTypeWarranties, setLocalJobTypeWarranties] = useState<JobTypeWarrantyItem[]>([]);
  const [isSavingWarranties, setIsSavingWarranties] = useState(false);

  // Modal State for Add / Edit Plan
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [planName, setPlanName] = useState('');
  const [planPrice, setPlanPrice] = useState<string>('');
  const [planPer, setPlanPer] = useState<string>('job');
  const [planPerCustom, setPlanPerCustom] = useState<string>('');
  const [planBilling, setPlanBilling] = useState<string>('One-time');
  const [planLenPreset, setPlanLenPreset] = useState<string>('12 months');
  const [planLenNum, setPlanLenNum] = useState<string>('12');
  const [planLenUnit, setPlanLenUnit] = useState<string>('months');
  const [planCovered, setPlanCovered] = useState<string>('');
  const [planFor, setPlanFor] = useState<string>('All job types');
  const [planActive, setPlanActive] = useState<boolean>(true);
  const [planFiles, setPlanFiles] = useState<BeePlanFileItem[]>([]);
  const [isSavingPlan, setIsSavingPlan] = useState(false);

  // Preview file state
  const [previewingFile, setPreviewingFile] = useState<BeePlanFileItem | null>(null);

  useEffect(() => {
    loadPlans();
    loadJobTypeWarranties();
  }, [loadPlans, loadJobTypeWarranties]);

  useEffect(() => {
    // Current job types from CRM Settings (Payments & Lists)
    const orgJobTypes = org?.job_type_options && org.job_type_options.length > 0
      ? org.job_type_options
      : [];

    if (orgJobTypes.length > 0) {
      const savedMap = new Map(jobTypeWarranties.map((j) => [j.job_type, j]));
      const merged: JobTypeWarrantyItem[] = orgJobTypes.map((jt) => {
        const existing = savedMap.get(jt);
        if (existing) {
          return { ...existing };
        }
        const lower = jt.toLowerCase();
        let included_warranty = '12 months';
        let warranty_days = 365;
        let call_threshold_days = 30;
        if (lower.includes('install')) {
          included_warranty = '12 months';
          warranty_days = 365;
          call_threshold_days = 45;
        } else if (lower.includes('repair')) {
          included_warranty = '90 days';
          warranty_days = 90;
          call_threshold_days = 21;
        } else if (lower.includes('maintenance')) {
          included_warranty = '6 months';
          warranty_days = 180;
          call_threshold_days = 30;
        }
        return {
          job_type: jt,
          included_warranty,
          warranty_days,
          call_threshold_days,
        };
      });
      setLocalJobTypeWarranties(merged);
    } else if (jobTypeWarranties.length > 0) {
      setLocalJobTypeWarranties(JSON.parse(JSON.stringify(jobTypeWarranties)));
    }
  }, [org?.job_type_options, jobTypeWarranties]);

  // Handle Open Create / Edit Plan Modal
  const openPlanModal = (plan?: BeePlanItem) => {
    if (plan) {
      setEditingPlanId(plan.id);
      setPlanName(plan.name || '');
      setPlanPrice(plan.price !== undefined && plan.price !== null ? String(plan.price) : '');
      
      const perVal = plan.per || 'job';
      if (PER_OPTS.some((o) => o.value === perVal)) {
        setPlanPer(perVal);
        setPlanPerCustom('');
      } else {
        setPlanPer('custom');
        setPlanPerCustom(perVal);
      }

      const billingVal = plan.billing || (plan.billing_interval === 'yearly' ? 'Yearly' : plan.billing_interval === 'monthly' ? 'Monthly' : 'One-time');
      setPlanBilling(billingVal);

      const lenVal = plan.len || `${plan.duration_months || 12} months`;
      if (DUR_PRESETS.includes(lenVal)) {
        setPlanLenPreset(lenVal);
      } else {
        setPlanLenPreset('custom');
        const [num, unit = 'months'] = lenVal.split(' ');
        setPlanLenNum(num || '12');
        setPlanLenUnit(unit.endsWith('s') ? unit : `${unit}s`);
      }

      setPlanCovered(plan.covered || plan.description || '');
      setPlanFor(plan.for || (Array.isArray(plan.eligible_job_types) && plan.eligible_job_types.length > 0 ? (plan.eligible_job_types[0] || 'All job types') : 'All job types'));
      setPlanActive(plan.is_active ?? true);
      setPlanFiles(Array.isArray(plan.files) ? [...plan.files] : []);
    } else {
      setEditingPlanId(null);
      setPlanName('');
      setPlanPrice('');
      setPlanPer('job');
      setPlanPerCustom('');
      setPlanBilling('One-time');
      setPlanLenPreset('12 months');
      setPlanLenNum('12');
      setPlanLenUnit('months');
      setPlanCovered('');
      setPlanFor('All job types');
      setPlanActive(true);
      setPlanFiles([]);
    }
    setIsPlanModalOpen(true);
  };

  // Calculate live customer pitch preview
  const getPitchPreview = () => {
    const finalPrice = planPrice === '' ? '$-' : money(planPrice);
    const perText = planPer === 'custom' ? (planPerCustom ? ` / ${planPerCustom}` : '') : (planPer !== 'job' ? ` / ${planPer}` : '');
    const billText = planBilling === 'Yearly' ? ' / yr' : planBilling === 'Monthly' ? ' / mo' : '';
    const formattedPriceWithUnits = `${finalPrice}${perText}${billText}`;
    
    const lenText = planLenPreset === 'custom'
      ? `${planLenNum} ${planLenUnit}`
      : planLenPreset;

    const nameText = planName.trim() || 'This plan';
    const oneTimePhrase = planBilling === 'One-time' ? ' one time' : '';
    const coversPhrase = lenText ? `, covers ${lenText}` : '';
    const coveredPhrase = planCovered.trim() ? `: ${planCovered.trim()}` : '';

    return `${nameText} is ${formattedPriceWithUnits}${oneTimePhrase}${coversPhrase}${coveredPhrase}.`;
  };

  // File upload handler
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const filesArray = Array.from(e.target.files);
    
    filesArray.forEach((file) => {
      if (file.size > 2 * 1024 * 1024) {
        showToast(`${file.name} is over 2 MB.`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setPlanFiles((prev) => [
          ...prev,
          {
            name: file.name,
            type: file.type || '',
            size: file.size,
            url: reader.result as string,
          },
        ]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  // Remove attached file
  const removeAttachedFile = (idx: number) => {
    setPlanFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  // Save Plan
  const handleSavePlan = async () => {
    if (!planName.trim()) {
      showToast('Give the plan a name');
      return;
    }
    if (planPrice === '' || isNaN(parseFloat(planPrice))) {
      showToast('Set a price');
      return;
    }

    const priceNum = parseFloat(planPrice);
    const finalPer = planPer === 'custom' ? (planPerCustom.trim() || 'item') : planPer;
    const finalLen = planLenPreset === 'custom' ? `${planLenNum} ${planLenUnit}` : planLenPreset;
    
    const payload = {
      name: planName.trim(),
      price: priceNum,
      per: finalPer,
      billing: planBilling,
      billing_interval: planBilling.toLowerCase() === 'yearly' ? 'yearly' : planBilling.toLowerCase() === 'monthly' ? 'monthly' : 'one_time',
      len: finalLen,
      covered: planCovered.trim(),
      description: planCovered.trim(),
      for: planFor,
      eligible_job_types: [planFor],
      active: planActive,
      is_active: planActive,
      files: planFiles,
    };

    setIsSavingPlan(true);
    try {
      if (editingPlanId) {
        await updatePlan(editingPlanId, payload);
        showToast(`Saved changes to ${planName.trim()}`);
      } else {
        await createPlan(payload);
        showToast(`Added plan ${planName.trim()}`);
      }
      setIsPlanModalOpen(false);
    } catch (err: any) {
      showToast(err.message || 'Failed to save plan');
    } finally {
      setIsSavingPlan(false);
    }
  };

  // Delete Plan
  const handleDeletePlan = async () => {
    if (!editingPlanId) return;
    const ok = await confirm({
      title: `Delete the "${planName}" plan?`,
      description: 'Agents will stop offering it.',
      tone: 'danger',
      confirmLabel: 'Delete plan',
    });
    if (!ok) return;

    try {
      await deletePlan(editingPlanId);
      showToast(`Plan deleted`);
      setIsPlanModalOpen(false);
    } catch (err: any) {
      showToast(err.message || 'Failed to delete plan');
    }
  };

  // Toggle Plan Active Switch directly in table
  const handleTogglePlanActive = async (plan: BeePlanItem, checked: boolean) => {
    try {
      await updatePlan(plan.id, { is_active: checked });
      showToast(checked ? 'Plan turned on - agents can offer it' : 'Plan turned off - agents stop offering it');
    } catch (err: any) {
      showToast(err.message || 'Failed to update plan status');
    }
  };

  // Update inline job type warranty
  const handleJobTypeChange = (idx: number, field: keyof JobTypeWarrantyItem, val: any) => {
    setLocalJobTypeWarranties((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], [field]: val } as JobTypeWarrantyItem;
      return copy;
    });
  };

  // Toggle inline job type activation status (Active / Inactive)
  const handleJobTypeToggle = async (idx: number, checked: boolean) => {
    const updated = [...localJobTypeWarranties];
    const target = updated[idx];
    if (!target) return;
    updated[idx] = { ...target, is_active: checked };
    setLocalJobTypeWarranties(updated);
    try {
      await saveJobTypeWarranties(updated);
      showToast(
        checked
          ? `Enabled warranty calls for "${target.job_type}"`
          : `Disabled warranty calls for "${target.job_type}" (jobs will be skipped)`
      );
    } catch (err: any) {
      showToast(err.message || 'Failed to update job type activation');
    }
  };

  // Save Job Type Warranties
  const handleSaveJobTypeWarranties = async () => {
    setIsSavingWarranties(true);
    try {
      await saveJobTypeWarranties(localJobTypeWarranties);
      showToast('Included warranties updated and applied to warranty countdowns');
    } catch (err: any) {
      showToast(err.message || 'Failed to save warranty rules');
    } finally {
      setIsSavingWarranties(false);
    }
  };

  // Extract all available job type names for the "Offer to" dropdown directly from Payments & Lists
  const availableJobTypeOptions = [
    'All job types',
    'Commercial',
    'Residential',
    ...(org?.job_type_options && org.job_type_options.length > 0
      ? org.job_type_options
      : localJobTypeWarranties.map((j) => j.job_type)),
  ];
  const uniqueJobTypeOptions = Array.from(new Set(availableJobTypeOptions.filter(Boolean)));

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 bg-foreground text-surface-light px-4 py-2.5 rounded-lg shadow-xl text-xs font-medium animate-in fade-in slide-in-from-bottom-2">
          {toastMessage}
        </div>
      )}

      {/* Header Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <Heading level={2} scale="lg">
            Warranty plans
          </Heading>
          <p className="text-xs text-muted-foreground mt-0.5">
            Agents can only offer plans from this list.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            size="sm"
            onClick={() => openPlanModal()}
            className="gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            Add plan
          </Button>
        </div>
      </div>

      {/* Table 1: Warranty Plans Card */}
      <div className="border border-border/80 shadow-sm overflow-hidden bg-surface-light rounded-2xl">
        <div className="overflow-x-auto">
          <Table className="w-full">
            <TableHeader>
              <TableRow>
                <TableHead>Plan</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Billing</TableHead>
                <TableHead>Length</TableHead>
                <TableHead>What's covered</TableHead>
                <TableHead>For</TableHead>
                <TableHead className="text-center">Active</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8}>
                    <div className="py-8 text-center text-muted-foreground italic text-xs">
                      No plans yet. Click Add plan.
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                plans.map((p) => {
                  const pBilling = p.billing || (p.billing_interval === 'yearly' ? 'Yearly' : p.billing_interval === 'monthly' ? 'Monthly' : 'One-time');
                  const pLen = p.len || `${p.duration_months} months`;
                  const pCovered = p.covered || p.description || '-';
                  const pFor = p.for || (Array.isArray(p.eligible_job_types) && p.eligible_job_types.length > 0 ? p.eligible_job_types[0] : 'All job types');
                  const pFiles = Array.isArray(p.files) ? p.files : [];

                  return (
                    <TableRow key={p.id}>
                      <TableCell>
                        <span className="font-semibold text-foreground text-sm">{p.name}</span>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium text-foreground whitespace-nowrap text-xs">{priceText(p)}</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-muted-foreground whitespace-nowrap text-xs">{pBilling}</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-muted-foreground whitespace-nowrap text-xs">{pLen}</span>
                      </TableCell>
                      <TableCell>
                        <div className="max-w-md">
                          <span className="text-foreground leading-relaxed block text-xs">{pCovered}</span>
                          {pFiles.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {pFiles.map((f, k) => (
                                <div
                                  key={k}
                                  role="button"
                                  tabIndex={0}
                                  onClick={() => setPreviewingFile(f)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      setPreviewingFile(f);
                                    }
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border/80 bg-surface-light hover:bg-muted/60 text-[11px] font-medium text-foreground/90 transition-colors cursor-pointer select-none"
                                  title="Click to preview file"
                                >
                                  <Paperclip className="h-3 w-3 text-muted-foreground" />
                                  <span className="truncate max-w-[140px]">{f.name}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-muted-foreground whitespace-nowrap text-xs">{pFor}</span>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-center">
                          <Switch
                            checked={p.is_active}
                            onCheckedChange={(checked) => handleTogglePlanActive(p, checked)}
                          />
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openPlanModal(p)}
                            className="px-2.5"
                          >
                            Edit
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Table 2: Included warranty per job type */}
      <div className="border border-border/60 shadow-sm bg-surface-light p-5 space-y-4 rounded-2xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/40 pb-3">
          <div>
            <Heading level={3} scale="base">
              Included warranty per job type
            </Heading>
            <p className="text-xs text-muted-foreground mt-0.5">
              Bee uses these to know when a customer's original warranty expires. Warranty countdown starts right after the invoice is sent for the completed job. First call triggers the specified number of days before warranty expiration.
            </p>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-auto flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/settings/payments')}
              className="gap-1.5"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Edit Job types
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <Table className="w-full">
            <TableHeader>
              <TableRow>
                <TableHead>Job type</TableHead>
                <TableHead>Included warranty</TableHead>
                <TableHead>First Call (Days Before warranty expiration)</TableHead>
                <TableHead className="w-24 text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {localJobTypeWarranties.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4}>
                    <div className="py-8 text-center text-muted-foreground text-xs">
                      <p className="font-medium">No job types configured for this organization.</p>
                      <p className="text-[11px] mt-1">Configure your job types in CRM Settings to manage their warranty rules.</p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigate('/settings/payments')}
                        className="mt-3 gap-1.5"
                      >
                        <ExternalLink className="h-3 w-3" />
                        Configure Job Types in Payments & Lists
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                localJobTypeWarranties.map((rule, idx) => {
                const currentWarranty = rule.included_warranty || '12 months';
                const isCustom = !DUR_PRESETS.includes(currentWarranty) && currentWarranty !== 'No warranty';
                const isActive = rule.is_active ?? true;

                return (
                  <TableRow key={idx} className={cn(!isActive && 'bg-muted/15 opacity-80')}>
                    <TableCell>
                      <span className={cn('font-semibold text-xs', isActive ? 'text-foreground' : 'text-muted-foreground')}>
                        {rule.job_type}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 flex-wrap">
                        <SelectField
                          options={[
                            { value: 'No warranty', label: 'No warranty' },
                            ...DUR_PRESETS.map((p) => ({ value: p, label: p })),
                            { value: 'custom', label: 'Custom…' },
                          ]}
                          value={isCustom ? 'custom' : currentWarranty}
                          onValueChange={(val) => {
                            if (val === 'custom') {
                              handleJobTypeChange(idx, 'included_warranty', '60 days');
                            } else {
                              handleJobTypeChange(idx, 'included_warranty', val);
                            }
                          }}
                          size="sm"
                          className="w-[150px]"
                        />

                        {isCustom && (
                          <div className="flex items-center gap-1.5">
                            <Input
                              type="number"
                              min="1"
                              value={parseInt(currentWarranty) || 30}
                              onChange={(e) => {
                                const num = e.target.value;
                                const [, unit = 'days'] = currentWarranty.split(' ');
                                handleJobTypeChange(idx, 'included_warranty', `${num} ${unit}`);
                              }}
                              className="w-20"
                              placeholder="Days"
                            />
                            <SelectField
                              options={UNITS.map((u) => ({ value: u, label: u }))}
                              value={currentWarranty.split(' ')[1] || 'days'}
                              onValueChange={(unit) => {
                                const num = parseInt(currentWarranty) || 30;
                                handleJobTypeChange(idx, 'included_warranty', `${num} ${unit}`);
                              }}
                              size="sm"
                              className="w-24"
                            />
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min="0"
                          value={rule.call_threshold_days ?? 30}
                          onChange={(e) => handleJobTypeChange(idx, 'call_threshold_days', parseInt(e.target.value) || 0)}
                          className="w-24"
                          placeholder="e.g. 30"
                        />
                        <span className="text-muted-foreground text-[11px]">days</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end">
                        <Switch
                          checked={isActive}
                          onCheckedChange={(checked) => handleJobTypeToggle(idx, checked)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
            </TableBody>
          </Table>
        </div>

        <div className="flex justify-end pt-2 border-t border-border/40">
          <Button
            size="sm"
            onClick={handleSaveJobTypeWarranties}
            disabled={isSavingWarranties}
            className="gap-1.5"
          >
            <Check className="h-3.5 w-3.5" />
            {isSavingWarranties ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      {/* Add / Edit Warranty Plan Modal */}
      <Dialog open={isPlanModalOpen} onOpenChange={setIsPlanModalOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader className="pb-3">
            <DialogTitle>
              {editingPlanId ? 'Edit plan' : 'New warranty plan'}
            </DialogTitle>
            <DialogDescription>
              Agents read the price and what's covered word for word, so write it the way you'd say it to a customer.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2 text-xs">
            {/* Plan Name */}
            <div className="space-y-1.5">
              <Label>Plan name</Label>
              <Input
                value={planName}
                onChange={(e) => setPlanName(e.target.value)}
                placeholder="e.g. Platinum 1-Year Door Care"
                className="h-8"
              />
            </div>

            {/* Price & Per Unit */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Price</Label>
                <div className="relative">
                  <span className="absolute left-2.5 top-2 text-muted-foreground text-xs">$</span>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={planPrice}
                    onChange={(e) => setPlanPrice(e.target.value)}
                    placeholder="0.00"
                    className="pl-6"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Price is per</Label>
                <SelectField
                  options={[
                    ...PER_OPTS.map((o) => ({ value: o.value, label: o.label })),
                    { value: 'custom', label: 'Custom…' },
                  ]}
                  value={planPer}
                  onValueChange={setPlanPer}
                  size="sm"
                  className="w-full"
                />
                {planPer === 'custom' && (
                  <Input
                    value={planPerCustom}
                    onChange={(e) => setPlanPerCustom(e.target.value)}
                    placeholder="e.g. square foot, gate, camera"
                    className="mt-1.5"
                  />
                )}
              </div>
            </div>

            {/* Billing & Length */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Billing</Label>
                <SelectField
                  options={[
                    { value: 'One-time', label: 'One-time' },
                    { value: 'Monthly', label: 'Monthly' },
                    { value: 'Yearly', label: 'Yearly' },
                  ]}
                  value={planBilling}
                  onValueChange={setPlanBilling}
                  size="sm"
                  className="w-full"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Length</Label>
                <SelectField
                  options={[
                    ...DUR_PRESETS.map((d) => ({ value: d, label: d })),
                    { value: 'custom', label: 'Custom…' },
                  ]}
                  value={planLenPreset}
                  onValueChange={setPlanLenPreset}
                  size="sm"
                  className="w-full"
                />

                {planLenPreset === 'custom' && (
                  <div className="flex items-center gap-2 mt-1.5">
                    <Input
                      type="number"
                      min="1"
                      value={planLenNum}
                      onChange={(e) => setPlanLenNum(e.target.value)}
                      placeholder="Amount"
                      className="w-24"
                    />
                    <SelectField
                      options={UNITS.map((u) => ({ value: u, label: u }))}
                      value={planLenUnit}
                      onValueChange={setPlanLenUnit}
                      size="sm"
                      className="flex-1"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* What's Covered */}
            <div className="space-y-1.5">
              <Label>What's covered</Label>
              <Textarea
                rows={3}
                value={planCovered}
                onChange={(e) => setPlanCovered(e.target.value)}
                placeholder="e.g. 1-year labor extension, 1 preventive maintenance visit per year, 10% off parts"
                className="resize-none"
              />
            </div>

            {/* Attachments */}
            <div className="space-y-2">
              <Label className="block">Attachments</Label>
              {planFiles.length > 0 ? (
                <div className="space-y-1.5">
                  {planFiles.map((f, k) => (
                    <div
                      key={k}
                      className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-md border border-border/80 bg-muted/20 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="font-medium truncate max-w-[280px]">{f.name}</span>
                        <span className="text-muted-foreground text-[11px]">({fileSize(f.size)})</span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => setPreviewingFile(f)}
                          className="px-2"
                        >
                          Preview
                        </Button>
                        <Button
                          variant="ghost"
                          tone="danger"
                          size="sm"
                          type="button"
                          onClick={() => removeAttachedFile(k)}
                          className="px-2"
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-muted-foreground text-xs block">No files attached.</span>
              )}

              <div>
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-input bg-surface-light hover:bg-muted/50 cursor-pointer text-xs font-medium transition-colors">
                  <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>Upload contract or file</span>
                  <input
                    type="file"
                    multiple
                    accept=".pdf,.doc,.docx,.txt,image/*"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>
                <span className="text-[11px] text-muted-foreground block mt-1">
                  PDF, Word, text or image. The office can send these to the customer after the sale.
                </span>
              </div>
            </div>

            {/* Offer to & Status */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div className="space-y-1.5">
                <Label>Offer to</Label>
                <SelectField
                  options={uniqueJobTypeOptions.map((opt) => ({ value: opt, label: opt }))}
                  value={planFor}
                  onValueChange={setPlanFor}
                  size="sm"
                  className="w-full"
                />
              </div>

              <div className="space-y-1.5 flex flex-col justify-end pb-1">
                <Label className="mb-1">Status</Label>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={planActive}
                    onCheckedChange={setPlanActive}
                  />
                  <span className="text-xs text-foreground font-normal">Active - agents can offer it</span>
                </div>
              </div>
            </div>

            {/* Live Customer Pitch Preview Card */}
            <div className="mt-3 p-3.5 rounded-lg border border-border/80 bg-muted/40 space-y-1">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
                Customer hears:
              </span>
              <p className="text-xs text-foreground font-medium leading-relaxed italic">
                "{getPitchPreview()}"
              </p>
            </div>
          </div>

          <DialogFooter className="flex items-center justify-between pt-3 mt-2 sm:justify-between">
            <div>
              {editingPlanId && (
                <Button
                  variant="outline"
                  tone="danger"
                  size="sm"
                  type="button"
                  onClick={handleDeletePlan}
                  className="gap-1.5"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete plan
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsPlanModalOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSavePlan}
                disabled={isSavingPlan}
              >
                {editingPlanId ? 'Save changes' : 'Add plan'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* File Preview Modal */}
      {previewingFile && (
        <Dialog open={!!previewingFile} onOpenChange={() => setPreviewingFile(null)}>
          <DialogContent className="max-w-xl">
            <DialogHeader className="pb-2">
              <DialogTitle className="flex items-center gap-2">
                <Paperclip className="h-4 w-4 text-primary" />
                {previewingFile.name}
              </DialogTitle>
              <DialogDescription>
                {fileSize(previewingFile.size)} · {previewingFile.type || 'Document'}
              </DialogDescription>
            </DialogHeader>

            <div className="py-4 flex flex-col items-center justify-center min-h-[160px] bg-muted/20 rounded-md border border-border/50">
              {previewingFile.type?.startsWith('image/') && previewingFile.url ? (
                <img
                  src={previewingFile.url}
                  alt={previewingFile.name}
                  className="max-h-[340px] max-w-full rounded object-contain shadow-sm"
                />
              ) : (
                <div className="text-center space-y-2 p-6">
                  <FileText className="h-10 w-10 text-muted-foreground mx-auto" />
                  <p className="text-xs font-medium text-foreground">{previewingFile.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    Document preview ready. The office can attach or send this file to customers during closing.
                  </p>
                  {previewingFile.url && (
                    <a
                      href={previewingFile.url}
                      download={previewingFile.name}
                      className="inline-flex items-center gap-1.5 text-xs text-primary font-medium hover:underline pt-2"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Download or open file
                    </a>
                  )}
                </div>
              )}
            </div>

            <DialogFooter className="pt-2">
              <Button size="sm" variant="outline" onClick={() => setPreviewingFile(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {confirmDialog}
    </div>
  );
};
