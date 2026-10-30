/** How many of a person's switches differ from their role, as a screen says it: "No changes", "1 change", "3 changes". */
export const changeCountLabel = (count: number) => (count === 0 ? 'No changes' : count === 1 ? '1 change' : `${count} changes`);
