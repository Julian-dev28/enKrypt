if (process.env.IS_DEV) {
  require("./hot-reload");
}
import "@/libs/utils/selective-wasm";
import {
  backgroundOnMessageFromWindow,
  backgroundOnMessageFromNewWindow,
  backgroundOnMessageFromAction,
  backgroundOnMessageFromBackground,
  backgroundOnMessageFromCS,
} from "@/libs/messenger/extension";
import { InternalOnMessageResponse } from "@/types/messenger";
import { OnMessageResponse } from "@enkryptcom/types";
import BackgroundHandler from "@/libs/background";
import Browser from "webextension-polyfill";
import openOnboard from "@/libs/utils/open-onboard";
import PublicKeyRing from "@/libs/keyring/public-keyring";

const backgroundHandler = new BackgroundHandler();
backgroundHandler.init();
backgroundOnMessageFromNewWindow((msg): Promise<InternalOnMessageResponse> => {
  return backgroundHandler.internalHandler(msg);
});
backgroundOnMessageFromWindow((msg): Promise<OnMessageResponse> => {
  return backgroundHandler.externalHandler(msg);
});
backgroundOnMessageFromAction((msg): Promise<InternalOnMessageResponse> => {
  return backgroundHandler.internalHandler(msg);
});
backgroundOnMessageFromBackground((msg): Promise<InternalOnMessageResponse> => {
  return backgroundHandler.internalHandler(msg);
});
backgroundOnMessageFromCS((msg): Promise<OnMessageResponse> => {
  return backgroundHandler.externalHandler(msg);
});

Browser.runtime.onInstalled.addListener((object) => {
  if (object.reason === "install") {
    const kr = new PublicKeyRing();
    kr.isInitialized().then((isInit) => {
      if (!isInit) openOnboard();
    });
  }
});

if (process.env.IS_SAFARI || process.env.IS_OPERA_EDGE) {
  Browser.scripting.registerContentScripts([
    {
      id: "inject-script",
      js: ["scripts/inject.js"],
      persistAcrossSessions: false,
      matches: ["http://*/*", "https://*/*"],
      runAt: "document_start",
      world: "MAIN",
    } as any,
  ]);
}
