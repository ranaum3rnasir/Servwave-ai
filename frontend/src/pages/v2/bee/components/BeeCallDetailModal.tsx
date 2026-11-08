import React from 'react';
import { useBeeStore } from '@/stores/beeStore';
import { OutcomeBadge } from '../tabs/BeeHomeTab';
import {
  Play,
  Pause,
  User,
  Bot,
  Sparkles,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatPhone, extractFailureMessage } from '@/lib/utils';

export const BeeCallDetailModal: React.FC = () => {
  const { selectedCallDetail, closeCallDetail } = useBeeStore();
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [playbackRate, setPlaybackRate] = React.useState(1);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  if (!selectedCallDetail) return null;

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const handleRateChange = (rate: number) => {
    setPlaybackRate(rate);
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  };

  return (
    <Dialog open={!!selectedCallDetail} onOpenChange={(open) => !open && closeCallDetail()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <DialogTitle>
                  {selectedCallDetail.customer_name}
                </DialogTitle>
                <OutcomeBadge outcome={selectedCallDetail.outcome} />
              </div>
              <p className="text-xs text-text-secondary mt-0.5 font-mono">
                {formatPhone(selectedCallDetail.customer_phone) || '-'} • {selectedCallDetail.duration_seconds}s call duration
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
          {/* Audio Player Bar */}
          <div className="p-3 bg-muted/30 border border-border rounded-xl flex items-center justify-between gap-3 shadow-xs">
            <audio
              ref={audioRef}
              src={selectedCallDetail.audio_url || 'https://actions.google.com/sounds/v1/ambiences/office_hallway.ogg'}
              onEnded={() => setIsPlaying(false)}
            />
            <div className="flex items-center gap-2.5">
              <Button
                size="icon"
                className="h-8 w-8"
                onClick={togglePlay}
              >
                {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current ml-0.5" />}
              </Button>
              <span className="text-xs font-semibold text-text-primary">Recording Playback</span>
            </div>

            <div className="flex items-center gap-1.5">
              {[1, 1.25, 1.5].map((rate) => (
                <Button
                  key={rate}
                  size="sm"
                  variant={playbackRate === rate ? 'solid' : 'outline'}
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() => handleRateChange(rate)}
                >
                  {rate}x
                </Button>
              ))}
            </div>
          </div>

          {/* AI Summary Card */}
          <div className="p-3.5 bg-ai-50 border border-ai-200 rounded-xl space-y-1.5 shadow-xs">
            <div className="flex items-center gap-1.5 text-ai-600 font-bold text-xs">
              <Sparkles className="h-3.5 w-3.5" />
              <span>AI Call Intelligence Summary</span>
            </div>
            <p className="text-text-primary text-xs leading-relaxed">
              {(() => {
                const isFail =
                  (selectedCallDetail.outcome || '').toUpperCase() === 'FAILED' ||
                  (selectedCallDetail.ai_summary || '').includes('failed:') ||
                  (selectedCallDetail.ai_summary || '').includes('rejected call');
                if (isFail && selectedCallDetail.ai_summary) {
                  return extractFailureMessage(selectedCallDetail.ai_summary);
                }
                return selectedCallDetail.ai_summary || 'No summary available.';
              })()}
            </p>
          </div>

          {/* Transcript Dialogue */}
          <div className="space-y-3 pt-2">
            <span className="text-xs font-bold text-text-secondary block">
              Full Call Transcript ({selectedCallDetail.transcript?.length || 0} turns)
            </span>

            <div className="space-y-2.5">
              {Array.isArray(selectedCallDetail.transcript) && selectedCallDetail.transcript.map((t, idx) => (
                <div
                  key={idx}
                  className={`flex gap-2.5 ${t.speaker === 'bee' ? 'items-start' : 'items-start flex-row-reverse'}`}
                >
                  <div
                    className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5 ${
                      t.speaker === 'bee'
                        ? 'bg-ai-50 text-ai-600 border border-ai-200'
                        : 'bg-muted text-text-primary border border-border'
                    }`}
                  >
                    {t.speaker === 'bee' ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
                  </div>

                  <div
                    className={`p-2.5 rounded-xl max-w-[80%] text-xs leading-relaxed ${
                      t.speaker === 'bee'
                        ? 'bg-muted/40 text-text-primary border border-border'
                        : 'bg-primary text-primary-foreground shadow-xs'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3 text-[10px] opacity-75 mb-1">
                      <span className="font-bold uppercase">{t.speaker === 'bee' ? 'Bee Voice Agent' : selectedCallDetail.customer_name}</span>
                      <span>{t.timestamp}s</span>
                    </div>
                    {t.text}
                  </div>
                </div>
              ))}

              {(!selectedCallDetail.transcript || selectedCallDetail.transcript.length === 0) && (
                <p className="text-text-secondary text-xs italic py-4 text-center">
                  No transcript generated for this interaction (e.g. voicemail or unanswered).
                </p>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
