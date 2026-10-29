/** Types for `breakpoints.js`, the one breakpoint source (see the notes there). */

export type ScreenName = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

export declare const SCREENS: Readonly<Record<ScreenName, number>>;

export declare const SHORT_HEIGHT_MAX: number;

export declare const tailwindScreens: Readonly<Record<ScreenName, string>>;

export declare const MEDIA: Readonly<{
  belowSm: string;
  belowMd: string;
  belowLg: string;
  belowXl: string;
  sm: string;
  md: string;
  lg: string;
  xl: string;
  shortHeight: string;
}>;
