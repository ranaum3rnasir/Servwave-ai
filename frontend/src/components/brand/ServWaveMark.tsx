/**
 * ServWave wave mark — the icon portion cropped from the master logo
 * (`src/assets/servwave-logo.svg`). Rendered inline with `fill="currentColor"`
 * so it can be tinted per surface (sage on the ocean chrome, white on the
 * login panel, ocean on light backgrounds). Pair it with the "ServWave"
 * Manrope wordmark rather than the lockup's baked-in Arial text.
 *
 * viewBox is cropped to the mark's measured bounding box (x 37.76, y 89.94,
 * w 107.56, h 74.13) with a touch of padding.
 */
interface ServWaveMarkProps {
  className?: string;
}

export function ServWaveMark({ className }: ServWaveMarkProps) {
  return (
    <svg
      viewBox="35 87 112 80"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M145.13,121.84c-6.12,8.65-16.99,16.42-28.11,17.87-11.7,1.53-20.43-1.31-30.49-7.06-8.15-4.66-16.8-6.67-26.16-5.93-7.98.63-14.87,3.62-22.61,7.35,7.75-9.73,18.55-16.05,30.38-18.61,10.92-2.36,21.33-.3,30.99,5.08,10.29,5.73,16.53,8.53,28.98,7.2,6.06-.65,11-3.33,17.01-5.91Z" />
      <path d="M145.32,98.76c-12.16,14.42-28.87,21.29-46.76,14.86-5.04-1.81-9.52-4.31-14.29-6.73-7.06-3.8-14.52-5.55-22.62-4.91-8.37.41-15.44,3.66-23.5,7.66,6.62-8.31,15.88-14.33,26.01-17.64,12.01-3.92,24.01-2.1,34.76,4.16,16.76,9.76,28.24,11.19,46.39,2.6Z" />
      <path d="M90.64,158.82l-4.85-2.5c-16.82-8.67-31.16-7.28-47.67,1.78,1.05-1.37,2.15-2.89,3.26-3.9,10.1-9.16,18.8-13.76,32.51-15.05,8.28-.78,16.23,1.17,23.5,5.05l4.62,2.47c5.22,2.79,10.35,4.92,16.35,5.66,9.5.79,18.1-2.38,26.8-7.47-12.56,17.64-34.64,25.08-54.52,13.97Z" />
    </svg>
  );
}
