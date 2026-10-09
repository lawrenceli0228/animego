// Toasts for the community tab, loaded on first use.
//
// react-hot-toast touches `document` while its module is evaluated, so a
// static import anywhere in a component's graph makes that component
// impossible to import from a bun test (see testImportHygiene.test.ts). The
// Toaster itself is mounted once by the [lang] layout; this only reaches the
// `toast` function, after the page is running in a browser.

type Kind = "success" | "error";

export function notify(kind: Kind, message: string): void {
  if (typeof window === "undefined") return;
  void import("react-hot-toast")
    .then(({ default: toast }) => {
      if (kind === "success") toast.success(message);
      else toast.error(message);
    })
    .catch(() => {
      /* a toast that fails to load is not worth an error of its own */
    });
}
