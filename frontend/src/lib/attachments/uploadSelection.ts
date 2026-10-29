/**
 * The shape a surface hands the upload UI: one selected file and everything known about it.
 *
 * In `lib/` rather than beside the component because it is data, not presentation - the
 * queue hook, `AttachmentSection`'s own pending model and `StageDetailDialog` all produce it,
 * and none of them should have to import a component to describe their state.
 */
/**
 * `cancelled` is not a flavour of `error`, and the difference is user-facing: an error owes
 * the user an explanation and a toast, a cancel is something they just did and owes them
 * nothing. Collapsing the two makes every deliberate cancel raise "Upload failed".
 */
export type UploadSelectionStatus =
  | 'selected'
  | 'uploading'
  | 'done'
  | 'error'
  | 'cancelled';

export interface UploadSelectionView {
  key: string;
  file: File;
  /** null whenever the browser could not measure it — never Infinity or NaN. */
  durationSeconds: number | null;
  status: UploadSelectionStatus;
  /** Bytes the transport says have gone out. */
  loaded: number;
  /** Bytes the transport says there are in total, when it knows. */
  total?: number;
  error?: string;
}
