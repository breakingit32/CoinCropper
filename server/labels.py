"""Parse what we can read off a certified-coin slab.

Two inputs feed this module:

* the raw value of a barcode / QR code printed on the slab label, and
* optional OCR text read from the label by the phone.

The output is a :class:`SlabInfo` with whatever could be determined
(grading service, cert number, grade, year, description...).  Nothing here
touches the network, so it is easy to test.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Optional
from urllib.parse import unquote, urlparse

SERVICES = ("PCGS", "NGC", "CACG", "ANACS", "ICG")

# Grade prefixes used on labels, longest first so "PR" beats "P".
_GRADE_PREFIXES = (
    "MS", "PR", "PF", "SP", "AU", "XF", "EF", "VF", "VG", "AG", "FR", "PO", "F", "G",
)
_DESIGNATIONS = (
    "ULTRA CAMEO", "CAMEO", "DMPL", "DCAM", "UCAM", "CAM", "DPL", "PL", "RD", "RB", "BN", "FBL", "FB",
    "FS", "FH", "FT",
)
_DESIG_CANON = {"ULTRA CAMEO": "UCAM", "CAMEO": "CAM"}  # NGC wording -> PCGS-style

GRADE_RE = re.compile(
    r"(?<![A-Z])(?P<prefix>" + "|".join(_GRADE_PREFIXES) + r")\s?-?\s?(?P<num>\d{1,2})"
    r"(?P<plus>\+)?(?:\s?(?P<desig>" + "|".join(_DESIGNATIONS) + r"))?(?![A-Z0-9])"
)
# Mint mark after a dash (PCGS "1916-D") or a space (NGC "1916 D").
YEAR_RE = re.compile(r"\b(1[6-9]\d{2}|20\d{2})(?:/\d{1,2})?(?:[-\s]?(?P<mint>CC|[PDSOWC])\b)?")
NGC_CERT_RE = re.compile(r"^(\d{6,8})-(\d{3})$")
DIGITS_RE = re.compile(r"^\d{6,20}$")
CERT_IN_TEXT_RE = re.compile(r"\b(\d{7,8}(?:-\d{3})?)\b")
PCGS_NO_IN_TEXT_RE = re.compile(r"\b(?:PCGS\s*#?|#)\s*(\d{3,6})\b", re.I)
# The line under the grade on PCGS labels: "<PCGS#>.<grade>/<cert>", e.g. 7268.64/2401136
PCGS_LINE_RE = re.compile(r"\b(\d{3,6})\s?\.\s?(\d{2})(\+)?\s?/\s?(\d{7,9})\b")
NGC_CERT_IN_TEXT_RE = re.compile(r"\b(\d{6,8}-\d{3})\b")


def grade_from_number(num: int, proof: bool = False) -> str:
    """Best-guess grade prefix when only the number was read."""
    if num >= 60:
        return f"{'PR' if proof else 'MS'}{num}"
    for low, prefix in ((50, "AU"), (40, "XF"), (20, "VF"), (12, "F"), (8, "VG"), (4, "G"), (3, "AG"), (2, "FR")):
        if num >= low:
            return f"{prefix}{num}"
    return f"PO{num}"


def label_anchor(line: str) -> Optional[dict]:
    """If an OCR line identifies a slab (PCGS#.grade/cert or an NGC cert), say so."""
    m = PCGS_LINE_RE.search(line)
    if m:
        return {"service": "PCGS", "pcgs_no": m.group(1), "grade_num": int(m.group(2)),
                "plus": bool(m.group(3)), "cert": m.group(4)}
    m = NGC_CERT_IN_TEXT_RE.search(line)
    if m:
        return {"service": "NGC", "cert": m.group(1)}
    return None


@dataclass
class SlabInfo:
    raw: str = ""
    service: Optional[str] = None
    cert: Optional[str] = None
    pcgs_no: Optional[str] = None
    grade: Optional[str] = None  # e.g. "MS65", "PR69 DCAM"
    grade_num: Optional[int] = None
    year: Optional[str] = None
    mint_mark: Optional[str] = None
    description: Optional[str] = None
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    def merge(self, other: "SlabInfo") -> "SlabInfo":
        """Fill blanks in self from other (self wins on conflicts)."""
        for k, v in asdict(other).items():
            if k == "notes":
                self.notes.extend(n for n in v if n not in self.notes)
            elif getattr(self, k) in (None, "") and v not in (None, ""):
                setattr(self, k, v)
        return self


def parse_barcode(raw: str) -> SlabInfo:
    """Work out service + cert number from a barcode/QR payload."""
    value = (raw or "").strip()
    info = SlabInfo(raw=value)
    if not value:
        return info

    # QR codes on newer labels are verification URLs.
    if value.lower().startswith(("http://", "https://", "www.")):
        url = urlparse(value if "://" in value else "https://" + value)
        host = url.netloc.lower()
        parts = [unquote(p) for p in url.path.split("/") if p]
        for svc, needle in (("PCGS", "pcgs"), ("NGC", "ngc"), ("CACG", "cacg"),
                            ("ANACS", "anacs"), ("ICG", "icgcoin")):
            if needle in host:
                info.service = svc
                break
        for p in parts:
            if NGC_CERT_RE.match(p) or DIGITS_RE.match(p):
                info.cert = p
                break
        if not info.cert:
            m = CERT_IN_TEXT_RE.search(url.path + "?" + url.query)
            if m:
                info.cert = m.group(1)
        return info

    compact = value.replace(" ", "")

    m = NGC_CERT_RE.match(compact)
    if m:
        info.service, info.cert = "NGC", compact
        return info

    # Some labels prefix the service name.
    for svc in SERVICES:
        if compact.upper().startswith(svc):
            rest = compact[len(svc):].lstrip(":#-")
            info.service = svc
            info.cert = rest or None
            return info

    if DIGITS_RE.match(compact):
        info.cert = compact
        # PCGS barcodes are plain 7-8 digit cert numbers; it is by far the most
        # common plain-digit label, so default to it but flag the guess.
        if len(compact) in (7, 8):
            info.service = "PCGS"
            info.notes.append("service guessed from barcode format")
        elif len(compact) > 8:
            # Older PCGS barcodes pack PCGS#/grade before the cert.  Keep
            # the last 8 digits as the cert.
            info.service = "PCGS"
            info.cert = compact[-8:]
            info.notes.append("long PCGS barcode: using last 8 digits as cert")
        return info

    info.notes.append("unrecognised barcode format")
    return info


def normalise_grade(text: str) -> tuple[Optional[str], Optional[int]]:
    m = GRADE_RE.search(text.upper())
    if not m:
        return None, None
    prefix = m.group("prefix")
    if prefix == "PF":
        prefix = "PR"
    if prefix == "EF":
        prefix = "XF"
    num = int(m.group("num"))
    if not 1 <= num <= 70:
        return None, None
    grade = f"{prefix}{num}{m.group('plus') or ''}"
    if m.group("desig"):
        grade += " " + _DESIG_CANON.get(m.group("desig"), m.group("desig"))
    return grade, num


def parse_label_text(text: str) -> SlabInfo:
    """Pull grade, year, cert etc. out of OCR'd label text."""
    info = SlabInfo()
    if not text:
        return info
    upper = text.upper()
    lines = [ln.strip() for ln in upper.splitlines() if ln.strip()]

    for svc in SERVICES:
        if re.search(rf"\b{svc}\b", upper):
            info.service = svc
            break

    info.grade, info.grade_num = normalise_grade(upper)

    line = PCGS_LINE_RE.search(upper)
    if line:
        info.service = "PCGS"
        info.pcgs_no, info.cert = line.group(1), line.group(4)
        num = int(line.group(2))
        if info.grade_num != num:
            proof = bool(re.search(r"\b(PR|PF|PROOF)\b", upper))
            info.grade = grade_from_number(num, proof) + ("+" if line.group(3) else "")
            info.grade_num = num
        return _finish_label(info, lines)

    m = CERT_IN_TEXT_RE.search(upper)
    if m:
        info.cert = m.group(1)
        if not info.service and NGC_CERT_RE.match(info.cert):
            info.service = "NGC"  # 1234567-001 form

    m = PCGS_NO_IN_TEXT_RE.search(upper)
    if m:
        info.pcgs_no = m.group(1)
    return _finish_label(info, lines)


def _finish_label(info: SlabInfo, lines: list[str]) -> SlabInfo:
    for ln in lines:
        ym = YEAR_RE.search(ln)
        if ym:
            info.year = ym.group(1)
            info.mint_mark = ym.group("mint")
            info.description = re.sub(r"\s+", " ", ln).strip(" .,-")
            break

    return info
