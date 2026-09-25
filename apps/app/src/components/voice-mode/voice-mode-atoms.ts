import { atom, useAtomValue, useSetAtom } from "jotai";

const voiceModeOpenAtom = atom(false);

export function useVoiceModeOpen(): boolean {
  return useAtomValue(voiceModeOpenAtom);
}

export function useVoiceModeOpenControl(): {
  open: () => void;
  close: () => void;
} {
  const setOpen = useSetAtom(voiceModeOpenAtom);
  return {
    open: () => {
      setOpen(true);
    },
    close: () => {
      setOpen(false);
    },
  };
}
