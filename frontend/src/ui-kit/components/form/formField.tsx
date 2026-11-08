"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import {
  Controller,
  FormProvider,
  useFormContext,
  useFormState,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";

import { cn } from "@/ui-kit/lib/utils";
import { Label } from "@/ui-kit/components/ui/label";

/**
 * The wiring layer between react-hook-form and our controls.
 *
 * The point is the a11y contract: each field gets one generated id, and the
 * label's htmlFor, the control's aria-describedby, and aria-invalid are all
 * derived from it. Done by hand at every call site, that association silently
 * rots - a renamed id here, a missing describedby there, and a screen reader
 * stops reading the error that just blocked the submit.
 *
 *   <Form {...form}>
 *     <form onSubmit={form.handleSubmit(onSubmit)}>
 *       <FormField
 *         control={form.control}
 *         name="customer"
 *         render={({ field }) => (
 *           <FormItem>
 *             <FormLabel required>Customer</FormLabel>
 *             <FormControl><Input placeholder="Harborview Dental" {...field} /></FormControl>
 *             <FormDescription>Who the work is billed to.</FormDescription>
 *             <FormMessage />
 *           </FormItem>
 *         )}
 *       />
 *     </form>
 *   </Form>
 */
const Form = FormProvider;

type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = { name: TName };

const FormFieldContext = React.createContext<FormFieldContextValue>({} as FormFieldContextValue);
const FormItemContext = React.createContext<{ id: string }>({} as { id: string });

function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({ ...props }: ControllerProps<TFieldValues, TName>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

function useFormField() {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const { getFieldState } = useFormContext();
  const formState = useFormState({ name: fieldContext.name });
  const fieldState = getFieldState(fieldContext.name, formState);

  if (!fieldContext) throw new Error("useFormField must be used within <FormField>");

  const { id } = itemContext;
  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-control`,
    formDescriptionId: `${id}-description`,
    formMessageId: `${id}-message`,
    ...fieldState,
  };
}

function FormItem({ className, ...props }: React.ComponentProps<"div">) {
  const id = React.useId();
  return (
    <FormItemContext.Provider value={{ id }}>
      <div data-slot="form-item" className={cn("flex flex-col gap-1.5", className)} {...props} />
    </FormItemContext.Provider>
  );
}

function FormLabel({
  className,
  required,
  children,
  ...props
}: React.ComponentProps<typeof Label> & { required?: boolean }) {
  const { error, formItemId } = useFormField();
  return (
    <Label
      data-slot="form-label"
      data-error={!!error}
      className={cn("data-[error=true]:text-destructive", className)}
      htmlFor={formItemId}
      {...props}
    >
      {children}
      {/* aria-hidden: "required" is already announced via the control's
          aria-required, so the asterisk is decoration for sighted users only. */}
      {required && <span className="text-destructive ml-0.5" aria-hidden>*</span>}
    </Label>
  );
}

function FormControl({ ...props }: React.ComponentProps<typeof Slot>) {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField();
  return (
    <Slot
      data-slot="form-control"
      id={formItemId}
      aria-describedby={error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId}
      aria-invalid={!!error}
      {...props}
    />
  );
}

function FormDescription({ className, ...props }: React.ComponentProps<"p">) {
  const { formDescriptionId } = useFormField();
  return (
    <p
      data-slot="form-description"
      id={formDescriptionId}
      className={cn("text-muted-foreground text-[12px] leading-normal", className)}
      {...props}
    />
  );
}

function FormMessage({ className, children, ...props }: React.ComponentProps<"p">) {
  const { error, formMessageId } = useFormField();
  const body = error ? String(error?.message ?? "") : children;
  if (!body) return null;

  return (
    <p
      data-slot="form-message"
      id={formMessageId}
      className={cn("text-destructive text-[12px] font-medium", className)}
      {...props}
    >
      {body}
    </p>
  );
}

export {
  Form, FormField, FormItem, FormLabel, FormControl,
  FormDescription, FormMessage, useFormField,
};
