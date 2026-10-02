/**
 * v0.2.3 rendering-enabled release assets, with and without stealth.
 * Source: GET https://api.github.com/repos/h4ckf0r0day/obscura/releases/tags/v0.2.3,
 * assets[].digest (sha256). Linux x86_64 render was additionally computed with
 * sha256sum on /tmp/obscura-investigation-bin/release.tar.gz (70,880,637 bytes)
 * and cross-checked against the matching API digest. No other assets downloaded.
 */
export const KNOWN_SHA256: Readonly<Record<string, string>> = Object.freeze({
  "0.2.3/obscura-x86_64-linux.tar.gz": "1534d1e6ddaf3d080ec4091eb41d0a4d8cc042a48b607d3c410fc13b482a9eec",
  "0.2.3/obscura-x86_64-linux-stealth.tar.gz": "1283fff4b781eca438294ae1ba4bf986b63d7628097150a3910ed8f3e3e2142e",
  "0.2.3/obscura-aarch64-linux.tar.gz": "5ecf980bca3060236a7a86ec7ed83d943e6598ee87caa46d20325d90bc75f979",
  "0.2.3/obscura-aarch64-linux-stealth.tar.gz": "dab4184c6b08a6066eaa5b9935ee5c3776fbc9f0173edfae5bf67990a63bb62e",
  "0.2.3/obscura-x86_64-macos.tar.gz": "d7c48122debc2ad9b24842df44560860dba765ea928b3f636b7f053225245116",
  "0.2.3/obscura-x86_64-macos-stealth.tar.gz": "c779c3facf1b491fca139dd717bafd684cf9c7dea478a50e8f116b4de7605e6b",
  "0.2.3/obscura-aarch64-macos.tar.gz": "45653cfad226f1c9b415603a2ed59477fcbd6335c742338ce133c05de0bdd056",
  "0.2.3/obscura-aarch64-macos-stealth.tar.gz": "5d3127d9e8eedacb0e35cdb1d174ca837b80e79405074d0b16010fbe818f21d0",
  "0.2.3/obscura-x86_64-windows.zip": "781a1b8bd12b65ec5aba95842e75e6f56b3101d360397506c0e35fe3f78536e8",
  "0.2.3/obscura-x86_64-windows-stealth.zip": "4d7311c69c3263bb8376055f9cb846968b75c77c444d4b5efa74b1018b456fb9",
});
