// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// ChatStore's storage, backed by the browser: loaded once, written through.

import {ChatStore, MemoryStorage} from './agent/chat/chat.js';
import type {BrowserProxy} from './mojo_transports.js';

const KEY = 'ditto.chats';

export async function loadChatStore(proxy: BrowserProxy): Promise<ChatStore> {
  const {json} = await proxy.handler.loadChats();
  const storage = new MemoryStorage();
  if (json) {
    storage.setItem(KEY, json);
  }
  return new ChatStore({
    getItem: key => storage.getItem(key),
    setItem: (key, value) => {
      storage.setItem(key, value);
      proxy.handler.saveChats(value);
    },
    removeItem: key => storage.removeItem(key),
  }, KEY);
}
