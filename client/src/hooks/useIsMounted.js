import { useEffect, useRef } from 'react';

// Returns a ref whose .current is true while the component is mounted.
// Use before setState in async callbacks to avoid updating an unmounted tree.
export default function useIsMounted() {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => { ref.current = false; };
  }, []);
  return ref;
}
