import { useCallback, useReducer } from "react";
import { extractErrorMessage } from "@bb/core-ui";
import type { SystemVoiceProfile } from "@bb/server-contract";
import {
  addVoiceProfileSample,
  createVoiceProfile,
  transcribeVoiceInput,
} from "@/lib/api";

export type CustomVoiceStep = "consent" | "sample" | "reference" | "create";

export interface CustomVoiceWizardState {
  step: CustomVoiceStep;
  consented: boolean;
  sample: File | null;
  name: string;
  referenceText: string;
  transcriptState: "idle" | "loading" | "done";
  submitting: boolean;
  error: string | null;
  createdProfile: SystemVoiceProfile | null;
}

export const initialCustomVoiceWizardState: CustomVoiceWizardState = {
  step: "consent",
  consented: false,
  sample: null,
  name: "",
  referenceText: "",
  transcriptState: "idle",
  submitting: false,
  error: null,
  createdProfile: null,
};

export type CustomVoiceWizardAction =
  | { type: "setConsented"; value: boolean }
  | { type: "setSample"; file: File }
  | { type: "setName"; value: string }
  | { type: "setReference"; value: string }
  | { type: "next" }
  | { type: "back" }
  | { type: "transcribeStart" }
  | { type: "transcribeDone"; text: string | null }
  | { type: "submitStart" }
  | { type: "submitCreatedProfile"; profile: SystemVoiceProfile }
  | { type: "submitDone" }
  | { type: "submitFailed"; error: string }
  | { type: "reset" };

export function canAdvanceFromStep(state: CustomVoiceWizardState): boolean {
  switch (state.step) {
    case "consent":
      return state.consented;
    case "sample":
      return state.sample !== null;
    case "reference": {
      const length = state.referenceText.trim().length;
      return length > 0 && length <= 5000;
    }
    case "create": {
      const nameLength = state.name.trim().length;
      return nameLength > 0 && nameLength <= 100;
    }
  }
}

export function customVoiceWizardReducer(
  state: CustomVoiceWizardState,
  action: CustomVoiceWizardAction,
): CustomVoiceWizardState {
  switch (action.type) {
    case "setConsented":
      return { ...state, consented: action.value };
    case "setSample":
      return {
        ...state,
        sample: action.file,
        referenceText: "",
        transcriptState: "idle",
        error: null,
      };
    case "setName":
      return { ...state, name: action.value.slice(0, 100) };
    case "setReference":
      return { ...state, referenceText: action.value.slice(0, 5000) };
    case "next": {
      if (!canAdvanceFromStep(state)) {
        return state;
      }
      const step: CustomVoiceStep =
        state.step === "consent"
          ? "sample"
          : state.step === "sample"
            ? "reference"
            : "create";
      return { ...state, step, error: null };
    }
    case "back": {
      const step: CustomVoiceStep =
        state.step === "create"
          ? "reference"
          : state.step === "reference"
            ? "sample"
            : "consent";
      return { ...state, step, error: null };
    }
    case "transcribeStart":
      return { ...state, transcriptState: "loading" };
    case "transcribeDone":
      return {
        ...state,
        transcriptState: "done",
        referenceText:
          action.text !== null && action.text.trim().length > 0
            ? action.text.slice(0, 5000)
            : state.referenceText,
      };
    case "submitStart":
      return { ...state, submitting: true, error: null };
    case "submitCreatedProfile":
      return {
        ...state,
        createdProfile: action.profile,
      };
    case "submitDone":
      return { ...state, submitting: false };
    case "submitFailed":
      return { ...state, submitting: false, error: action.error };
    case "reset":
      return initialCustomVoiceWizardState;
  }
}

export function useCustomVoiceWizard() {
  const [state, dispatch] = useReducer(
    customVoiceWizardReducer,
    initialCustomVoiceWizardState,
  );

  const advance = useCallback(() => {
    if (!canAdvanceFromStep(state)) {
      return;
    }
    if (state.step === "sample") {
      dispatch({ type: "transcribeStart" });
      const file = state.sample;
      if (file !== null) {
        void transcribeVoiceInput(file)
          .then((result) => {
            dispatch({ type: "transcribeDone", text: result.text });
          })
          .catch(() => {
            dispatch({ type: "transcribeDone", text: null });
          });
      }
    }
    dispatch({ type: "next" });
  }, [state]);

  const goBack = useCallback(() => {
    dispatch({ type: "back" });
  }, []);

  const submit = useCallback(async () => {
    if (state.sample === null || !canAdvanceFromStep(state)) {
      return;
    }
    dispatch({ type: "submitStart" });
    try {
      let profileId: string;
      if (state.createdProfile !== null) {
        profileId = state.createdProfile.id;
      } else {
        const created = await createVoiceProfile({
          name: state.name.trim(),
          description: null,
          language: "en",
          voiceType: "cloned",
          presetEngine: null,
          presetVoiceId: null,
        });
        profileId = created.profile.id;
        dispatch({ type: "submitCreatedProfile", profile: created.profile });
      }
      await addVoiceProfileSample(
        profileId,
        state.sample,
        state.referenceText.trim(),
      );
      dispatch({ type: "submitDone" });
    } catch (error) {
      dispatch({
        type: "submitFailed",
        error: extractErrorMessage(error) ?? "Failed to create voice",
      });
    }
  }, [state]);

  return {
    state,
    dispatch,
    advance,
    goBack,
    submit,
  };
}
