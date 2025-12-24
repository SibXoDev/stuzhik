import "solid-js";

declare module "solid-js" {
  namespace JSX {
    interface InputHTMLAttributes<T> {
      webkitdirectory?: boolean | string;
      directory?: boolean | string;
    }
  }
}
