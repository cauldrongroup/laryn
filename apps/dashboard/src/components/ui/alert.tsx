import * as React from "react";

import { cn } from "@/lib/utils";

function Alert({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert"
      className={cn("grid grid-cols-[auto_1fr_auto] items-start gap-3 rounded-lg border border-border bg-card p-4 text-sm", className)}
      role="status"
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return <h3 data-slot="alert-title" className={cn("font-semibold leading-none", className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("mt-1 text-sm leading-5 text-muted-foreground", className)} {...props} />;
}

export { Alert, AlertDescription, AlertTitle };
