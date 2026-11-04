/**
 * Viewer host: the concrete implementation of the capability interface that
 * viewers receive. Keeping it here (rather than inside each viewer) means a
 * viewer can be tested against a fake host, and Android only has to provide a
 * different implementation of these methods.
 */

import * as api from '@/api/library'
import type { ViewerHost } from '@/types/viewer'

export const viewerHost: ViewerHost = {
  readBinary: (entryId) => api.readBinary(entryId),
  readText: (entryId, encoding) => api.readText(entryId, encoding),
  entryPath: (entryId) => api.entryPath(entryId),
  entryUrl: (entryId) => api.entryUrl(entryId),
  saveProgress: async (entryId, progress) => {
    await api.setProgress(entryId, progress)
  },
}
