import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:focus-visible:ring-dark-primary/45 dark:focus-visible:ring-offset-dark-surface disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-on-primary hover:bg-primary-container dark:bg-dark-primary dark:text-dark-on-primary dark:hover:bg-dark-primary-container rounded-full",
        secondary:
          "bg-transparent ghost-border text-on-surface/90 hover:bg-surface-high hover:text-on-surface dark:text-dark-on-surface/90 dark:hover:bg-dark-surface-high dark:hover:text-dark-on-surface rounded-eight",
        ghost:
          "bg-transparent text-on-surface/90 hover:bg-surface-low hover:text-on-surface dark:text-dark-on-surface/90 dark:hover:bg-dark-surface-low dark:hover:text-dark-on-surface rounded-eight",
        danger:
          "bg-red-600 text-white hover:bg-red-700 rounded-eight",
      },
      size: {
        sm: "h-8 px-3 text-sm",
        md: "h-10 px-5 text-sm",
        lg: "h-12 px-6 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";
