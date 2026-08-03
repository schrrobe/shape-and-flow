import { computed, useId } from 'vue';

interface FieldDescriptionProps {
  readonly description?: string | null;
  readonly error?: string | null;
}

/** Keeps field accessibility ids and their announcement order consistent. */
export function useFieldIds(
  props: FieldDescriptionProps,
  trailingIds: (fieldId: string) => readonly (string | null)[] = () => [],
) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;

  const describedBy = computed(() => {
    const ids = [
      props.description === null ? null : descriptionId,
      props.error === null ? null : errorId,
      ...trailingIds(id),
    ].filter((value): value is string => value !== null);

    return ids.length === 0 ? undefined : ids.join(' ');
  });

  return { describedBy, descriptionId, errorId, id };
}
