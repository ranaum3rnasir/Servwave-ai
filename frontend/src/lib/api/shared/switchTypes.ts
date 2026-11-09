/** A switch's value: on/off, the chosen option of a choice switch, or a list switch's marker or chosen members. */
export type SwitchValue = boolean | string | string[];
export type SwitchSet = Record<string, SwitchValue>;

/** A role's switch values, as the Roles API answers a read or a write. */
export interface RoleSwitchSet {
  role: string;
  label: string;
  type: 'system' | 'custom';
  editable: boolean;
  base_role: string;
  made_from_role_key: string | null;
  made_from_blank: boolean;
  values: SwitchSet;
  all_views_off: boolean;
  /** Only on the answer to a save or a reset: how many people on the role follow the change, and how many keep their own value. */
  reaches?: number;
  keep_own?: number;
}
