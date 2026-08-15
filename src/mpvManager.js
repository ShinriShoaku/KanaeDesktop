"use strict";

/**
 * Portable / bundled mpv manager.
 *
 * PATCH:
 * - Download to temporary file.
 * - Validate downloaded mpv before installing.
 * - Never overwrite a working mpv with a broken binary.
 * - Validate existing bundled mpv.
 * - Automatically recover from corrupted local binary.
 * - Keep MPV_PATH override.
 * - Keep GitHub release discovery.
 */

const fs = require("fs");
const path = require("path");
const {
  execFile,
} = require("child_process");

const paths = require("./paths");

const BIN_DIR = path.join(
  paths.BASE_DIR,
  "bin"
);

const API_TIMEOUT_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 300000;

const GITHUB_REPO =
  "pkgforge-dev/mpv-AppImage";

const RELEASES_LATEST_PAGE =
  `https://github.com/${GITHUB_REPO}/releases/latest`;

// ─────────────────────────────────────────────────────────────
// PLATFORM
// ─────────────────────────────────────────────────────────────

function isSupportedPlatform() {
  return process.platform === "linux";
}

function archPattern() {
  if (process.arch === "arm64") {
    return /(aarch64|arm64)/i;
  }

  return /(x86_64|amd64|x64)/i;
}

// ─────────────────────────────────────────────────────────────
// PATHS
// ─────────────────────────────────────────────────────────────

function localBinPath() {
  return path.join(
    BIN_DIR,
    "mpv"
  );
}

function temporaryBinPath() {
  return `${localBinPath()}.download`;
}

function backupBinPath() {
  return `${localBinPath()}.backup`;
}

function markerPath() {
  return `${localBinPath()}.version`;
}

// ─────────────────────────────────────────────────────────────
// STATUS EVENT BUS
// ─────────────────────────────────────────────────────────────

const _statusListeners =
  new Set();

function onStatus(cb) {
  _statusListeners.add(cb);

  return () =>
    _statusListeners.delete(cb);
}

function emitStatus(
  status,
  data = {}
) {
  for (const cb of _statusListeners) {
    try {
      cb(status, data);
    } catch (e) {
      // A bad listener must not break mpv manager.
    }
  }
}

// ─────────────────────────────────────────────────────────────
// MPV PATH
// ─────────────────────────────────────────────────────────────

function getMpvBin() {
  // Explicit override.
  if (process.env.MPV_PATH) {
    return process.env.MPV_PATH;
  }

  const local =
    localBinPath();

  try {
    if (fs.existsSync(local)) {
      return local;
    }
  } catch (e) {
    // Ignore.
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// EXECUTABLE VALIDATION
// ─────────────────────────────────────────────────────────────

function getInstalledVersion(
  binPath
) {
  return new Promise((resolve) => {
    execFile(
      binPath,
      [
        "--no-config",
        "--version",
      ],
      {
        timeout: 10000,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve(null);
          return;
        }

        const output = String(
          stdout || stderr || ""
        ).trim();

        if (!output) {
          resolve(null);
          return;
        }

        const firstLine =
          output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean);

        if (!firstLine) {
          resolve(null);
          return;
        }

        if (!/\bmpv\b/i.test(firstLine)) {
          resolve(null);
          return;
        }

        resolve(firstLine);
      }
    );
  });
}

/**
 * More strict validation than just checking whether
 * the file exists.
 */
async function validateMpvBinary(
  binPath
) {
  if (!binPath) {
    return {
      valid: false,
      version: null,
      error: "Path mpv kosong",
    };
  }

  try {
    if (!fs.existsSync(binPath)) {
      return {
        valid: false,
        version: null,
        error: "File mpv tidak ditemukan",
      };
    }
  } catch (e) {
    return {
      valid: false,
      version: null,
      error: e.message,
    };
  }

  // Linux AppImage needs executable permission.
  if (process.platform === "linux") {
    try {
      fs.chmodSync(
        binPath,
        0o755
      );
    } catch (e) {
      // Continue; exec will tell us if it fails.
    }
  }

  const version =
    await getInstalledVersion(
      binPath
    );

  if (!version) {
    return {
      valid: false,
      version: null,
      error:
        "Binary tidak dapat menjalankan `mpv --no-config --version`",
    };
  }

  return {
    valid: true,
    version,
    error: null,
  };
}

// ─────────────────────────────────────────────────────────────
// GITHUB RELEASE DISCOVERY
// ─────────────────────────────────────────────────────────────

async function findLatestAsset() {
  const latestResp =
    await fetch(
      RELEASES_LATEST_PAGE,
      {
        headers: {
          "User-Agent":
            "KanaeDesktop-mpvManager",
        },
        redirect: "follow",
        signal:
          AbortSignal.timeout(
            API_TIMEOUT_MS
          ),
      }
    );

  if (!latestResp.ok) {
    throw new Error(
      `GitHub releases page responded with HTTP ${latestResp.status}`
    );
  }

  const tagMatch =
    latestResp.url.match(
      /\/releases\/tag\/([^/]+)$/
    );

  if (!tagMatch) {
    throw new Error(
      "Tidak bisa membaca tag rilis terbaru dari GitHub"
    );
  }

  const tag =
    decodeURIComponent(
      tagMatch[1]
    );

  const assetsResp =
    await fetch(
      `https://github.com/${GITHUB_REPO}/releases/expanded_assets/${encodeURIComponent(tag)}`,
      {
        headers: {
          "User-Agent":
            "KanaeDesktop-mpvManager",
        },
        signal:
          AbortSignal.timeout(
            API_TIMEOUT_MS
          ),
      }
    );

  if (!assetsResp.ok) {
    throw new Error(
      `GitHub expanded_assets responded with HTTP ${assetsResp.status}`
    );
  }

  const html =
    await assetsResp.text();

  const names = [
    ...new Set(
      [
        ...html.matchAll(
          /\/releases\/download\/[^"]*\/([^"/]+)/g
        ),
      ].map(
        (m) => m[1]
      )
    ),
  ];

  const arch =
    archPattern();

  const name =
    names.find(
      (n) =>
        /\.AppImage$/i.test(n) &&
        !/\.zsync$/i.test(n) &&
        arch.test(n)
    );

  if (!name) {
    throw new Error(
      `Tidak ada AppImage yang cocok untuk arch ${process.arch} di release terbaru (${tag})`
    );
  }

  return {
    url:
      `https://github.com/${GITHUB_REPO}/releases/latest/download/${name}`,
    tag,
    name,
  };
}

// ─────────────────────────────────────────────────────────────
// DOWNLOAD
// ─────────────────────────────────────────────────────────────

async function downloadAsset(
  url,
  destPath
) {
  const resp =
    await fetch(
      url,
      {
        headers: {
          "User-Agent":
            "KanaeDesktop-mpvManager",
        },
        redirect: "follow",
        signal:
          AbortSignal.timeout(
            DOWNLOAD_TIMEOUT_MS
          ),
      }
    );

  if (
    !resp.ok ||
    !resp.body
  ) {
    throw new Error(
      `Download failed with HTTP ${resp.status}`
    );
  }

  fs.mkdirSync(
    path.dirname(destPath),
    {
      recursive: true,
    }
  );

  // NEVER directly overwrite the active mpv.
  const tmpPath =
    `${destPath}.download`;

  try {
    // Remove stale temporary file.
    try {
      fs.unlinkSync(tmpPath);
    } catch (e) {
      // Nothing to remove.
    }

    const buf =
      Buffer.from(
        await resp.arrayBuffer()
      );

    if (!buf || buf.length < 1024) {
      throw new Error(
        `Downloaded mpv terlalu kecil (${buf ? buf.length : 0} bytes)`
      );
    }

    fs.writeFileSync(
      tmpPath,
      buf
    );

    if (
      process.platform ===
      "linux"
    ) {
      fs.chmodSync(
        tmpPath,
        0o755
      );
    }

    return tmpPath;
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (cleanupError) {
      // Ignore.
    }

    throw e;
  }
}

// ─────────────────────────────────────────────────────────────
// SAFE INSTALL
// ─────────────────────────────────────────────────────────────

async function installValidatedBinary(
  temporaryPath,
  targetPath
) {
  const validation =
    await validateMpvBinary(
      temporaryPath
    );

  if (!validation.valid) {
    throw new Error(
      `Downloaded mpv tidak valid: ${validation.error}`
    );
  }

  const backup =
    backupBinPath();

  const targetExists =
    fs.existsSync(
      targetPath
    );

  // Remove stale backup.
  try {
    fs.unlinkSync(backup);
  } catch (e) {
    // Ignore.
  }

  try {
    // Keep current binary safe.
    if (targetExists) {
      fs.renameSync(
        targetPath,
        backup
      );
    }

    // Install validated binary.
    fs.renameSync(
      temporaryPath,
      targetPath
    );

    // Validate installed binary again.
    const installed =
      await validateMpvBinary(
        targetPath
      );

    if (!installed.valid) {
      throw new Error(
        `Binary setelah install gagal validasi: ${installed.error}`
      );
    }

    // New binary works.
    try {
      fs.unlinkSync(
        backup
      );
    } catch (e) {
      // Ignore.
    }

    return installed;
  } catch (e) {
    // Remove failed target.
    try {
      fs.unlinkSync(
        targetPath
      );
    } catch (cleanupError) {
      // Ignore.
    }

    // Restore previous working binary.
    if (targetExists) {
      try {
        fs.renameSync(
          backup,
          targetPath
        );
      } catch (restoreError) {
        console.error(
          "[mpv] Gagal restore binary lama:",
          restoreError.message
        );
      }
    }

    throw e;
  } finally {
    // Never leave a temporary binary behind.
    try {
      fs.unlinkSync(
        temporaryPath
      );
    } catch (e) {
      // Ignore.
    }
  }
}

// ─────────────────────────────────────────────────────────────
// VERSION MARKER
// ─────────────────────────────────────────────────────────────

function getInstalledTag() {
  try {
    return (
      fs
        .readFileSync(
          markerPath(),
          "utf8"
        )
        .trim() ||
      null
    );
  } catch (e) {
    return null;
  }
}

function writeInstalledTag(tag) {
  try {
    fs.writeFileSync(
      markerPath(),
      tag || "",
      "utf8"
    );
  } catch (e) {
    // Best effort.
  }
}

// ─────────────────────────────────────────────────────────────
// CLEAN CORRUPTED LOCAL BINARY
// ─────────────────────────────────────────────────────────────

async function validateExistingLocal() {
  const local =
    localBinPath();

  if (!fs.existsSync(local)) {
    return {
      exists: false,
      valid: false,
      version: null,
    };
  }

  const result =
    await validateMpvBinary(
      local
    );

  if (result.valid) {
    console.log(
      `[mpv] Binary lokal valid: ${result.version}`
    );

    return {
      exists: true,
      valid: true,
      version: result.version,
    };
  }

  console.error(
    `[mpv] Binary lokal rusak/tidak valid: ${result.error}`
  );

  return {
    exists: true,
    valid: false,
    version: null,
  };
}

// ─────────────────────────────────────────────────────────────
// ENSURE MPV
// ─────────────────────────────────────────────────────────────

let _readyPromise = null;

async function ensureMpv() {
  // ───────────────────────────────────────────────
  // MPV_PATH override
  // ───────────────────────────────────────────────

  if (process.env.MPV_PATH) {
    console.log(
      `[mpv] MPV_PATH diset manual -> ${process.env.MPV_PATH}`
    );

    const validation =
      await validateMpvBinary(
        process.env.MPV_PATH
      );

    if (!validation.valid) {
      console.error(
        `[mpv] MPV_PATH tidak valid: ${validation.error}`
      );

      emitStatus(
        "error",
        {
          message:
            validation.error,
          path:
            process.env.MPV_PATH,
        }
      );

      return {
        path: process.env.MPV_PATH,
        updated: false,
        valid: false,
      };
    }

    emitStatus(
      "skipped",
      {
        path:
          process.env.MPV_PATH,
        version:
          validation.version,
      }
    );

    return {
      path:
        process.env.MPV_PATH,
      updated: false,
      valid: true,
    };
  }

  // ───────────────────────────────────────────────
  // Platform
  // ───────────────────────────────────────────────

  if (!isSupportedPlatform()) {
    emitStatus(
      "unsupported_platform",
      {
        platform:
          process.platform,
      }
    );

    return {
      path: null,
      updated: false,
      valid: false,
    };
  }

  const local =
    localBinPath();

  fs.mkdirSync(
    BIN_DIR,
    {
      recursive: true,
    }
  );

  // ───────────────────────────────────────────────
  // Validate existing binary
  // ───────────────────────────────────────────────

  const existing =
    await validateExistingLocal();

  // ───────────────────────────────────────────────
  // First run
  // ───────────────────────────────────────────────

  if (!existing.exists) {
    console.log(
      "[mpv] Belum ada mpv bundled - downloading portable mpv..."
    );

    emitStatus(
      "downloading",
      {
        firstRun: true,
      }
    );

    try {
      const {
        url,
        tag,
        name,
      } =
        await findLatestAsset();

      const temporary =
        await downloadAsset(
          url,
          local
        );

      const installed =
        await installValidatedBinary(
          temporary,
          local
        );

      writeInstalledTag(
        tag
      );

      console.log(
        `[mpv] Berhasil install ${installed.version}: ${local}`
      );

      emitStatus(
        "ready",
        {
          version:
            installed.version ||
            name,
          firstRun: true,
        }
      );

      return {
        path: local,
        updated: true,
        valid: true,
      };
    } catch (e) {
      console.error(
        `[mpv] Download/install bundled mpv gagal: ${e.message}`
      );

      emitStatus(
        "error",
        {
          message:
            e.message,
          firstRun: true,
        }
      );

      return {
        path: null,
        updated: false,
        valid: false,
      };
    }
  }

  // ───────────────────────────────────────────────
  // Existing binary invalid
  // ───────────────────────────────────────────────

  if (!existing.valid) {
    console.warn(
      "[mpv] Binary lokal invalid. Mencoba download ulang..."
    );

    emitStatus(
      "downloading",
      {
        recovery: true,
      }
    );

    try {
      const {
        url,
        tag,
        name,
      } =
        await findLatestAsset();

      const temporary =
        await downloadAsset(
          url,
          local
        );

      const installed =
        await installValidatedBinary(
          temporary,
          local
        );

      writeInstalledTag(
        tag
      );

      console.log(
        `[mpv] Recovery berhasil: ${installed.version || name}`
      );

      emitStatus(
        "ready",
        {
          version:
            installed.version ||
            name,
          recovery: true,
        }
      );

      return {
        path: local,
        updated: true,
        valid: true,
      };
    } catch (e) {
      console.error(
        `[mpv] Recovery binary gagal: ${e.message}`
      );

      // Don't return broken local path.
      try {
        fs.unlinkSync(
          local
        );
      } catch (cleanupError) {
        // Ignore.
      }

      emitStatus(
        "error",
        {
          message:
            e.message,
          recovery: true,
        }
      );

      return {
        path: null,
        updated: false,
        valid: false,
      };
    }
  }

  // ───────────────────────────────────────────────
  // Existing binary valid
  // ───────────────────────────────────────────────

  emitStatus(
    "checking",
    {}
  );

  let latest;

  try {
    latest =
      await findLatestAsset();
  } catch (e) {
    console.log(
      `[mpv] Cek update gagal (${e.message}) - pakai binary lokal.`
    );

    emitStatus(
      "up_to_date",
      {
        checkFailed: true,
        version:
          existing.version,
      }
    );

    return {
      path: local,
      updated: false,
      valid: true,
    };
  }

  const installedTag =
    getInstalledTag();

  if (
    installedTag &&
    installedTag === latest.tag
  ) {
    console.log(
      `[mpv] ${latest.name} - sudah versi terbaru.`
    );

    emitStatus(
      "up_to_date",
      {
        version:
          existing.version ||
          latest.name,
      }
    );

    return {
      path: local,
      updated: false,
      valid: true,
    };
  }

  // ───────────────────────────────────────────────
  // Update
  // ───────────────────────────────────────────────

  console.log(
    `[mpv] Update tersedia (${latest.name}). Downloading...`
  );

  emitStatus(
    "updating",
    {
      to:
        latest.name,
    }
  );

  try {
    const temporary =
      await downloadAsset(
        latest.url,
        local
      );

    const installed =
      await installValidatedBinary(
        temporary,
        local
      );

    writeInstalledTag(
      latest.tag
    );

    console.log(
      `[mpv] Berhasil update ke ${installed.version || latest.name}.`
    );

    emitStatus(
      "ready",
      {
        version:
          installed.version ||
          latest.name,
        updated: true,
      }
    );

    return {
      path: local,
      updated: true,
      valid: true,
    };
  } catch (e) {
    console.error(
      `[mpv] Update gagal (${e.message}) - binary lama tetap dipertahankan.`
    );

    // IMPORTANT:
    // installValidatedBinary() restores the old
    // binary automatically if the new binary fails.

    emitStatus(
      "error",
      {
        message:
          e.message,
      }
    );

    return {
      path: local,
      updated: false,
      valid: true,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// BACKGROUND START
// ─────────────────────────────────────────────────────────────

function startEnsureMpv() {
  if (!_readyPromise) {
    _readyPromise =
      ensureMpv().catch(
        (e) => {
          console.error(
            "[mpv] ensureMpv unexpected error:",
            e.message
          );

          return {
            path: null,
            updated: false,
            valid: false,
          };
        }
      );
  }

  return _readyPromise;
}

function waitUntilReady() {
  return startEnsureMpv();
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
  ensureMpv,
  startEnsureMpv,
  waitUntilReady,
  onStatus,
  getMpvBin,
  localBinPath,
  validateMpvBinary,
};