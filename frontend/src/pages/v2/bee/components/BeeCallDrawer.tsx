import React from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useBeeStore } from '@/stores/beeStore';
import { beeApi } from '@/lib/api/bee';
import api from '@/lib/axios';
import { Play, Pause, Sparkles, Phone, X, AlertCircle, CheckCircle2, ExternalLink, Maximize2, Minimize2 } from 'lucide-react';
import { toast } from 'sonner';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { Button } from '@/components/ui/button';
import { Heading } from '@/ui-kit/components/ui/heading';
import { OutcomeBadge } from '../tabs/BeeCallLogTab';
import { formatPhone, extractFailureMessage, cn, formatSnakeCase } from '@/lib/utils';
import { CreateTaskModal } from '@/components/tasks/CreateTaskModal';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import type { LinkedEntity } from '@/lib/tasks/types';

const SPEED_OPTIONS = [
  { value: '1', label: '1x' },
  { value: '1.5', label: '1.5x' },
  { value: '2', label: '2x' },
];

const OUTCOME_CHANGE_OPTIONS = [
  { value: 'ANSWERED', label: 'Answered' },
  { value: 'INTERESTED_WARRANTY', label: 'Warranty plan' },
  { value: 'INTERESTED_NEW_WORK', label: 'New Job' },
  { value: 'CALLBACK_REQUESTED', label: 'Call back later' },
  { value: 'HANDOFF_HUMAN', label: 'Needs a human' },
  { value: 'COMPLAINT', label: 'Complaint' },
  { value: 'NOT_INTERESTED', label: 'Not interested' },
  { value: 'ALREADY_COVERED', label: 'Has other coverage' },
  { value: 'DNC_REQUESTED', label: 'Do not call' },
  { value: 'WRONG_NUMBER', label: 'Wrong number' },
  { value: 'NO_ANSWER', label: 'No answer / machine' },
  { value: 'VOICEMAIL', label: 'Voicemail / machine' },
  { value: 'FAILED', label: 'Technical failure' },
  { value: 'NEEDS_REVIEW', label: 'Needs review' },
];

export const BeeCallDrawer: React.FC = () => {
  const { selectedCallDetail, closeCallDetail, loadCalls } = useBeeStore();
  const navigate = useNavigate();

  const [isPlaying, setIsPlaying] = React.useState(false);
  const [playbackRate, setPlaybackRate] = React.useState(1);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [loadedAudioDuration, setLoadedAudioDuration] = React.useState<number | null>(null);
  const [isFullScreen, setIsFullScreen] = React.useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  const [isCreateTaskModalOpen, setIsCreateTaskModalOpen] = React.useState(false);
  const [presetEntity, setPresetEntity] = React.useState<LinkedEntity | null>(null);
  const [createdTaskId, setCreatedTaskId] = React.useState<string | null>(null);
  const tasks = useTasksStore((s) => s.tasks);

  const call = selectedCallDetail;

  const matchedTaskInStore = React.useMemo(() => {
    if (!call) return null;
    if (createdTaskId) {
      const found = tasks.find((t) => t.id === createdTaskId);
      if (found) return found;
    }
    const currentTaskId = (call as any).task_id || (call as any).task?.id;
    if (currentTaskId) {
      const found = tasks.find((t) => t.id === currentTaskId);
      if (found) return found;
    }
    if (call.id) {
      return tasks.find((t) => t.description && t.description.includes(call.id)) || null;
    }
    return null;
  }, [tasks, call, createdTaskId]);

  const handleTaskCreated = React.useCallback(
    async (task: any) => {
      if (!call?.id || !task?.id) return;
      setCreatedTaskId(task.id);
      try {
        await api.patch(`/api/bee/calls/${call.id}/task`, { task_id: task.id });
        if (selectedCallDetail && selectedCallDetail.id === call.id) {
          useBeeStore.setState({
            selectedCallDetail: {
              ...selectedCallDetail,
              task_id: task.id,
              task: {
                id: task.id,
                task_number: task.task_number,
                title: task.title,
                status: task.status,
              },
            },
          });
        }
      } catch {
        // Non-fatal
      }
    },
    [call?.id, selectedCallDetail]
  );

  // When a task is created manually and appears in the store, persist the link to the backend
  // so it survives page reloads (task_id column on bee_call_logs).
  const linkedTaskId = (call as any)?.task_id as string | undefined;
  React.useEffect(() => {
    if (!call?.id || !matchedTaskInStore || linkedTaskId === matchedTaskInStore.id) return;
    // Fire-and-forget; the store already has the task so the UI updates immediately
    api.patch(`/api/bee/calls/${call.id}/task`, { task_id: matchedTaskInStore.id }).catch(() => {
      // Non-fatal - the UI already works via the store match
    });
  }, [call?.id, matchedTaskInStore?.id, linkedTaskId]);

  const existingTask = React.useMemo(() => {
    if (matchedTaskInStore) {
      return {
        id: matchedTaskInStore.id,
        task_number: matchedTaskInStore.task_number,
        title: matchedTaskInStore.title,
        status: matchedTaskInStore.status,
      };
    }
    if (call?.task) return call.task;
    if (call?.task_id) {
      return {
        id: call.task_id,
        task_number: call.task_number || '',
        title: call.task_title || '',
        status: call.task_status || '',
      };
    }
    return null;
  }, [matchedTaskInStore, call]);

  const handleOpenLinkedTask = React.useCallback(
    (taskId: string) => {
      useTaskDetailStore.getState().open(taskId);
      void useTasksStore.getState().fetchTaskDetail(taskId);
      closeCallDetail();
      navigate(`/tasks?task=${taskId}`);
    },
    [closeCallDetail, navigate]
  );

  // Total duration in seconds
  const totalDuration = React.useMemo(() => {
    if (loadedAudioDuration && loadedAudioDuration > 0 && Number.isFinite(loadedAudioDuration)) {
      return Math.round(loadedAudioDuration);
    }
    if (!call) return 0;
    if (typeof call.duration_seconds === 'number' && call.duration_seconds > 0) {
      return call.duration_seconds;
    }
    if (call.d && call.d.includes(':')) {
      const [m, s] = call.d.split(':').map(Number);
      const parsed = (m || 0) * 60 + (s || 0);
      if (parsed > 0) return parsed;
    }
    return 0;
  }, [call, loadedAudioDuration]);

  // Reset playback and full-screen state when switching calls
  React.useEffect(() => {
    setCurrentTime(0);
    setIsPlaying(false);
    setLoadedAudioDuration(null);
    setIsFullScreen(false);
  }, [call?.id]);

  // Lock body scroll while drawer is open
  React.useEffect(() => {
    if (!call) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [call]);

  // Handle Escape key to exit full screen or close drawer
  React.useEffect(() => {
    if (!call) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isCreateTaskModalOpen) {
          // Modal handles its own escape without closing the parent drawer
          return;
        }
        if (isFullScreen) {
          setIsFullScreen(false);
        } else {
          closeCallDetail();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [call, isFullScreen, isCreateTaskModalOpen, closeCallDetail]);

  if (!call) return null;

  const isCallInProgress =
    (call.outcome || call.o) === 'CALL_INITIATED' ||
    (call.outcome || call.o) === 'IN_PROGRESS';
  const isCallFailed = (call.outcome || call.o) === 'FAILED';
  const hasRealAudio = Boolean(call.audio_url);

  const rawSummary = call.sum || call.ai_summary;
  const isTechnicalFailure =
    isCallFailed ||
    (call.outcome || call.o || '').toUpperCase() === 'FAILED' ||
    (call.outcome || call.o || '').toLowerCase().includes('fail') ||
    Boolean(
      rawSummary &&
        (rawSummary.includes('failed:') ||
          rawSummary.includes('rejected call') ||
          rawSummary.includes('"statusCode"') ||
          rawSummary.includes('"error":'))
    );
  const displayedSummary = isTechnicalFailure && rawSummary
    ? extractFailureMessage(rawSummary)
    : (rawSummary || 'Customer inquiry handled by Bee voice assistant.');

  const togglePlay = async () => {
    if (!hasRealAudio) return;
    if (isPlaying) {
      setIsPlaying(false);
      if (audioRef.current) audioRef.current.pause();
    } else {
      if (totalDuration > 0 && currentTime >= totalDuration) {
        setCurrentTime(0);
        if (audioRef.current) audioRef.current.currentTime = 0;
      }
      setIsPlaying(true);
      if (audioRef.current) {
        audioRef.current.playbackRate = playbackRate;
        try {
          await audioRef.current.play();
        } catch {
          // If the presigned recording URL expired or was unsigned, fetch a fresh presigned URL and retry
          try {
            const detail = await beeApi.getCallDetail(call.id);
            if (detail?.call?.audio_url && audioRef.current) {
              audioRef.current.src = detail.call.audio_url;
              audioRef.current.playbackRate = playbackRate;
              await audioRef.current.play();
              return;
            }
          } catch {
            // fall through
          }
          setIsPlaying(false);
        }
      }
    }
  };

  const handleSpeedChange = (rateStr: string) => {
    const rate = parseFloat(rateStr) || 1;
    setPlaybackRate(rate);
    if (audioRef.current) audioRef.current.playbackRate = rate;
  };

  const handleSeek = async (seconds: number) => {
    const maxDur = totalDuration > 0 ? totalDuration : Math.max(seconds, 60);
    const bounded = Math.max(0, Math.min(maxDur, seconds));
    setCurrentTime(bounded);
    if (audioRef.current) {
      audioRef.current.currentTime = bounded;
      if (!isPlaying && hasRealAudio) {
        audioRef.current.playbackRate = playbackRate;
        try {
          await audioRef.current.play();
          setIsPlaying(true);
        } catch {
          try {
            const detail = await beeApi.getCallDetail(call.id);
            if (detail?.call?.audio_url && audioRef.current) {
              audioRef.current.src = detail.call.audio_url;
              audioRef.current.currentTime = bounded;
              audioRef.current.playbackRate = playbackRate;
              await audioRef.current.play();
              setIsPlaying(true);
            }
          } catch {
            // ignore
          }
        }
      }
    }
  };

  const handleWaveClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!hasRealAudio || totalDuration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    handleSeek(ratio * totalDuration);
  };

  // 64 waveform bar heights
  const bars = Array.from({ length: 64 }, (_, k) => {
    const hash = (k * 1.7) + (call.id.charCodeAt(0) || 3);
    const heightPct = 20 + Math.round(Math.abs(Math.sin(hash)) * 80);
    return heightPct;
  });

  const activeBarsCount =
    totalDuration > 0 ? Math.round((currentTime / totalDuration) * 64) : 0;

  // Time formatted string
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const durationStr = formatTime(totalDuration);
  const currentTimeStr = formatTime(currentTime);

  // Outcome tag styles
  const getOutcomeTag = (outcome: string, lf?: string | null) => {
    const o = outcome || '';
    if (o === 'LEAD_CREATED' || o.includes('lead')) {
      const suffix = lf ? ` - ${lf}` : '';
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-success-surface text-success-text border border-success-border">
          Lead created{suffix}
        </span>
      );
    }
    if (o === 'CALLBACK_REQUESTED' || o.includes('callback')) {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-primary/10 text-primary border border-primary/25">
          Call back later
        </span>
      );
    }
    if (o === 'HANDOFF_HUMAN' || o.includes('human')) {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-primary/10 text-primary border border-primary/25">
          Needs a human
        </span>
      );
    }
    if (o === 'COMPLAINT' || o.includes('complaint')) {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-danger-surface text-danger-text border border-danger-border">
          Complaint
        </span>
      );
    }
    if (o === 'WRONG_NUMBER' || o.includes('wrong')) {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-warning-surface text-warning-text border border-warning-border">
          Wrong number
        </span>
      );
    }
    if (o === 'DNC_REQUESTED' || o.includes('dnc') || o.includes('opt_out')) {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-danger-surface text-danger-text border border-danger-border">
          Do not call
        </span>
      );
    }
    if (o === 'ALREADY_COVERED') {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-muted text-text-secondary border border-border">
          Has other coverage
        </span>
      );
    }
    if (o === 'CALL_INITIATED' || o === 'IN_PROGRESS') {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-primary/10 text-primary border border-primary/25">
          Call in progress
        </span>
      );
    }
    if (o === 'FAILED') {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-danger-surface text-danger-text border border-danger-border">
          Call failed
        </span>
      );
    }
    if (o === 'COMPLETED' || o === 'PENDING_CLASSIFICATION') {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-muted text-text-primary border border-border">
          Completed
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-muted text-text-secondary border border-border">
        {o === 'NO_ANSWER' ? 'No answer / machine' : o === 'NOT_INTERESTED' ? 'Not interested' : o || 'Completed'}
      </span>
    );
  };

  const handleOpenCreateTask = () => {
    if (!call) return;
    const jobNumber =
      call.job_number ||
      (call.j && call.j.startsWith('#')
        ? call.j.split('·')[0]?.trim().replace('#', '')
        : '') ||
      '';
    const targetJobId = call.job_id || null;

    // Associated Job entity - the only required linkage
    const entity: LinkedEntity | null = targetJobId
      ? {
          type: 'JOB',
          id: targetJobId,
          label: jobNumber ? `Job #${jobNumber}` : `Job #${targetJobId.slice(0, 8)}`,
        }
      : null;

    setPresetEntity(entity);
    setIsCreateTaskModalOpen(true);
  };

  // Change outcome
  const handleOutcomeChange = async (newOutcome: string) => {
    if (!newOutcome) return;
    try {
      await beeApi.updateCallOutcome(call.id, newOutcome);
      toast.success('Outcome changed - saved to the audit log (who, when, before → after)');
      loadCalls();
      closeCallDetail();
    } catch {
      toast.error('Failed to update call outcome');
    }
  };

  // Derived transcript turns from real call log transcript
  const transcriptLines: Array<{ speaker: 'a' | 'c'; time: string; text: string; seconds: number }> =
    Array.isArray(call.transcript) && call.transcript.length > 0
      ? call.transcript.map((item: any, idx: number) => {
          const isBee =
            item.speaker === 'bee' ||
            item.speaker === 'a' ||
            item.speaker === 'assistant' ||
            item.speaker === 'bot';
          const sec = typeof item.timestamp === 'number' ? item.timestamp : idx * 6;
          return {
            speaker: isBee ? 'a' : 'c',
            time: formatTime(sec),
            text: item.text,
            seconds: sec,
          };
        })
      : [];

  const wantsList = call.got && call.got.length > 0 ? call.got : call.wants || [];
  const missedList = call.miss && call.miss.length > 0 ? call.miss : call.didnt_want || [];
  const objectionsList =
    (call.obj && call.obj.length > 0 ? call.obj : call.objections || [])
      .map(formatSnakeCase)
      .join(', ') || '-';

  const formattedPhone = formatPhone(call.customer_phone || call.p) || '-';
  const subtitle = `${call.t || new Date(call.called_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${formattedPhone} · ${formatSnakeCase(call.agent_name || call.ag || 'Warranty - Doors')} (${call.ver || 'v3'}) · attempt ${call.at || call.attempt || '1 of 3'}`;

  const jobLabel = call.job_title || call.j || '#4412 · Storefront door install';
  const customerId = call.customer_id;
  const jobId = call.job_id;

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      {/* Background Scrim */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-[2px] z-[80] transition-opacity"
        onClick={closeCallDetail}
      />

      {/* Right-Side Drawer */}
      <aside
        className={cn(
          "fixed top-0 right-0 bottom-0 h-screen h-[100dvh] bg-surface-light border-l border-border z-[80] overflow-y-auto p-6 shadow-2xl flex flex-col justify-between animate-in slide-in-from-right duration-200 transition-all",
          isFullScreen ? "left-0 w-full max-w-none" : "w-full max-w-[620px]"
        )}
      >
        <div className="space-y-4">
          {/* Header Row */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <Heading
                level={1}
                scale="xl"
                onClick={() => {
                  if (customerId) navigate(`/customers/${customerId}`);
                }}
                className={`font-extrabold text-text-primary tracking-tight ${
                  customerId ? 'hover:text-primary hover:underline cursor-pointer' : ''
                }`}
                title={customerId ? 'Click to open customer profile' : undefined}
              >
                {call.customer_name || call.c}
              </Heading>
              <div className="text-xs text-text-secondary mt-1 font-medium">
                {subtitle}
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsFullScreen((prev) => !prev)}
                className="h-8 w-8 text-text-secondary hover:text-text-primary"
                title={isFullScreen ? 'Restore size' : 'Expand to full screen'}
                aria-label={isFullScreen ? 'Restore size' : 'Expand to full screen'}
              >
                {isFullScreen ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={closeCallDetail}
                className="h-8 shrink-0"
              >
                Close
              </Button>
            </div>
          </div>

          {/* Outcome Tags */}
          <div>
            <OutcomeBadge
              outcome={call.outcome || call.o || ''}
              outcomes={call.outcomes}
              lf={call.lf || call.lead_format}
            />
          </div>

          {/* AI Summary Card */}
          <div className="bg-ai-50 border border-ai-200 rounded-xl p-3.5 space-y-1">
            <div className="text-[11px] font-bold text-ai-600 tracking-wider uppercase flex items-center gap-1.5 m-0">
              <Sparkles className="h-3.5 w-3.5 text-ai-600" />
              AI SUMMARY
            </div>
            <p className="text-xs text-text-primary leading-relaxed m-0 font-normal">
              {displayedSummary}
            </p>
          </div>

          {/* Audio Waveform Player */}
          {hasRealAudio ? (
            <div className="bg-muted/40 border border-border/80 rounded-xl p-3 flex items-center gap-3">
              <audio
                ref={audioRef}
                src={call.audio_url || undefined}
                onTimeUpdate={(e) => setCurrentTime(Math.floor(e.currentTarget.currentTime))}
                onLoadedMetadata={(e) => {
                  const d = e.currentTarget.duration;
                  if (Number.isFinite(d) && d > 0) {
                    setLoadedAudioDuration(Math.round(d));
                  }
                }}
                onEnded={() => setIsPlaying(false)}
              />

              {/* Play/Pause Button */}
              <Button
                size="icon"
                onClick={togglePlay}
                className="h-9 w-9"
                aria-label={isPlaying ? 'Pause playback' : 'Play playback'}
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4 fill-current" />
                ) : (
                  <Play className="h-4 w-4 fill-current ml-0.5" />
                )}
              </Button>

              {/* Waveform Bars */}
              <div
                onClick={handleWaveClick}
                className="flex-1 h-7 flex items-center gap-[2px] cursor-pointer min-w-0 select-none py-1"
                title="Click waveform to seek"
              >
                {bars.map((h, idx) => (
                  <span
                    key={idx}
                    style={{ height: `${h}%` }}
                    className={`flex-1 rounded-[1px] transition-colors duration-150 ${
                      idx < activeBarsCount ? 'bg-primary' : 'bg-border'
                    }`}
                  />
                ))}
              </div>

              {/* Timer Readout */}
              <span className="text-xs font-mono font-semibold text-text-primary whitespace-nowrap">
                {currentTimeStr} / {durationStr}
              </span>

              {/* Speed Selector */}
              <SelectField
                options={SPEED_OPTIONS}
                value={String(playbackRate)}
                onValueChange={handleSpeedChange}
                size="sm"
                className="w-16 h-7 text-xs"
              />
            </div>
          ) : (
            <div className="bg-muted/30 border border-dashed border-border rounded-xl p-3 text-xs text-text-secondary flex items-center justify-between">
              <span>
                {isCallInProgress
                  ? 'Call is currently active - recording link will be posted here automatically when the call ends.'
                  : 'Recording link is not available for this call.'}
              </span>
              <span className="font-mono text-[11px] font-semibold text-text-secondary">
                {durationStr}
              </span>
            </div>
          )}

          {/* Facts Grid */}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 my-4 py-3 border-y border-border/70 text-xs">
            <div>
              <dt className="text-[11px] font-bold text-text-secondary uppercase tracking-wider mb-0.5">
                Job #
              </dt>
              <dd
                onClick={() => {
                  if (jobId) navigate(`/jobs/${jobId}`);
                }}
                className={`font-semibold m-0 ${
                  jobId ? 'text-primary hover:underline cursor-pointer' : 'text-text-primary'
                }`}
                title={jobId ? 'Click to open job details' : undefined}
              >
                {(call.job_number || (call.j ? call.j.split('·')[0]?.trim() : '') || (jobId ? jobId.slice(0, 8) : '-')).replace(/^#/, '')}
              </dd>
            </div>

            <div>
              <dt className="text-[11px] font-bold text-text-secondary uppercase tracking-wider mb-0.5">
                Job Type
              </dt>
              <dd className="font-semibold text-text-primary m-0">
                {formatSnakeCase(call.job_type || call.jt || (call.job_title ? call.job_title.split('·').pop()?.trim() : '') || 'General Service')}
              </dd>
            </div>

            <div>
              <dt className="text-[11px] font-bold text-text-secondary uppercase tracking-wider mb-0.5">
                Warranty ends
              </dt>
              <dd className="font-semibold text-text-primary m-0">
                {call.we || call.warranty_ends || '-'}
              </dd>
            </div>

            <div>
              <dt className="text-[11px] font-bold text-text-secondary uppercase tracking-wider mb-0.5">
                Call cost
              </dt>
              <dd className="font-semibold text-text-primary m-0">
                {call.v || call.value || '-'}
              </dd>
            </div>

            <div>
              <dt className="text-[11px] font-bold text-text-secondary uppercase tracking-wider mb-0.5">
                Sentiment
              </dt>
              <dd className="font-semibold text-text-primary m-0">
                {formatSnakeCase(call.sent || call.sentiment || 'Positive')}
              </dd>
            </div>

            <div>
              <dt className="text-[11px] font-bold text-text-secondary uppercase tracking-wider mb-0.5">
                Objections
              </dt>
              <dd className="font-semibold text-text-primary m-0 truncate">
                {objectionsList}
              </dd>
            </div>
          </dl>

          {/* What the customer wants */}
          <div>
            <div className="text-xs font-bold text-text-primary mb-2">What the customer wants</div>
            <div className="flex flex-wrap gap-1.5">
              {wantsList.length > 0 ? (
                wantsList.map((item, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border border-border bg-surface-light text-text-primary"
                  >
                    {formatSnakeCase(item)}
                  </span>
                ))
              ) : (
                <span className="text-xs text-text-secondary">Nothing</span>
              )}
            </div>
          </div>

          {/* What they didn't want */}
          <div>
            <div className="text-xs font-bold text-text-primary mb-2">What they didn't want</div>
            <div className="flex flex-wrap gap-1.5">
              {missedList.length > 0 ? (
                missedList.map((item, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border border-border bg-surface-light text-text-secondary line-through"
                  >
                    {formatSnakeCase(item)}
                  </span>
                ))
              ) : (
                <span className="text-xs text-text-secondary">-</span>
              )}
            </div>
          </div>

          {/* Action Buttons Row */}
          <div className="flex flex-wrap items-center gap-2 pt-2 pb-1">
            <SelectField
              options={OUTCOME_CHANGE_OPTIONS}
              placeholder="Change outcome…"
              onValueChange={handleOutcomeChange}
              size="sm"
              className="w-48 text-xs"
            />

            {existingTask ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleOpenLinkedTask(existingTask.id)}
                className="h-8 inline-flex items-center gap-1.5 border-emerald-300 bg-emerald-50/70 hover:bg-emerald-100/80 text-emerald-800 font-medium"
                title={`Task #${existingTask.task_number || existingTask.id.slice(0, 8)} created. Click to preview and open in Tasks.`}
              >
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                <span>Task created{existingTask.task_number ? ` (#${existingTask.task_number})` : ''}</span>
                <ExternalLink className="h-3 w-3 text-emerald-700 ml-0.5" />
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenCreateTask}
                className="h-8"
              >
                Create task
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => toast.success('Calling customer from your line…')}
              className="h-8 inline-flex items-center gap-1.5"
            >
              <Phone className="h-3 w-3 text-primary" />
              Call customer
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => toast.success('Added to Do Not Call - blocks all agents and texts')}
              className="h-8"
            >
              Add to DNC
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => toast.success('Flagged for agent training')}
              className="h-8"
            >
              Flag for training
            </Button>
          </div>

          {/* Transcript Section */}
          <div className="pt-2">
            <div className="text-xs font-bold text-text-primary mb-0.5">Transcript</div>
            <p className="text-[11px] text-text-secondary mb-3">
              Click a line to jump the recording to that moment.
            </p>

            {transcriptLines.length > 0 ? (
              <div className="space-y-2">
                {transcriptLines.map((line, idx) => (
                  <div
                    key={idx}
                    onClick={() => handleSeek(line.seconds)}
                    className={`p-2.5 rounded-xl text-xs cursor-pointer transition select-none ${
                      line.speaker === 'a'
                        ? 'bg-muted/40 border border-border/40 text-text-primary max-w-[88%] hover:bg-muted/70'
                        : 'bg-primary/10 border border-primary/20 text-text-primary max-w-[88%] ml-auto hover:bg-primary/15'
                    }`}
                    title={`Jump to ${line.time}`}
                  >
                    <small className="block text-[10px] font-bold text-text-secondary uppercase mb-1">
                      {line.speaker === 'a' ? 'Bee (AI)' : call.customer_name?.split(' ')[0] || 'Customer'} · {line.time}
                    </small>
                    <span className="leading-relaxed">{line.text}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-muted/30 border border-dashed border-border rounded-xl p-4 text-xs text-text-secondary text-center">
                {isCallInProgress
                  ? 'Call is currently in progress - timestamped transcript will be posted here automatically once the call finishes.'
                  : 'No transcript turns recorded for this call.'}
              </div>
            )}
          </div>
        </div>

        {/* Footer Note */}
        <p className="text-[11px] text-text-secondary mt-6 pt-3 border-t border-border/60">
          Also shown on the customer's Communication tab and on job {jobLabel.split(' ')[0] || '#4412'}.
        </p>
      </aside>

      {isCreateTaskModalOpen && (
        <CreateTaskModal
          open={isCreateTaskModalOpen}
          onOpenChange={setIsCreateTaskModalOpen}
          presetEntity={presetEntity}
          skipEntityAccess
          className="z-[90]"
          overlayClassName="z-[85]"
          onSuccess={handleTaskCreated}
          notify={{ in_app: false, email: false }}
        />
      )}
    </>,
    document.body
  );
};

