// The one Switch lives in the ui-kit (the one "Allow partial payments" uses). This path stays only
// so existing imports keep working; it must remain a pure re-export (guarded by
// __tests__/one-switch.guard.test.ts).
export { Switch } from '@/ui-kit/components/ui/switch';
