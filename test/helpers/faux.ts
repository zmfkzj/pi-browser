import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, InMemoryCredentialStore, type FauxResponseStep } from "@earendil-works/pi-ai";

// Minimal independent copy of the sibling package's faux runtime pattern.
let serial = 0;
export async function fauxRuntime(responses: FauxResponseStep[] = []) {
  const faux = fauxProvider({ provider: `browser-faux-${++serial}` });
  faux.setResponses(responses);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  return { runtime, faux };
}
