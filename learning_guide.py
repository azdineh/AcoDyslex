"""Local-only A4 learning-guide PDF generated from persisted session data."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime
from html import escape
from io import BytesIO
from pathlib import Path
import os
import json
from math import ceil

import arabic_reshaper
from bidi.algorithm import get_display
from reportlab.graphics.shapes import Drawing, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    BaseDocTemplate, Flowable, Frame, KeepTogether, PageBreak, Paragraph,
    Spacer, Table, TableStyle,
)

from arabic_g2p import G2P_VERSION
from progress import service as progress_service

NAVY = colors.HexColor("#101827")
BLUE = colors.HexColor("#2764C5")
TEAL = colors.HexColor("#087F78")
PALE = colors.HexColor("#F6F9FC")
INK = colors.HexColor("#25364A")
MUTED = colors.HexColor("#5F7185")
ORANGE = colors.HexColor("#D17B36")
PAGE_WIDTH, PAGE_HEIGHT = A4
GUIDE_RESOURCES = Path(__file__).resolve().parent / "guideres"
COVER_IMAGE = GUIDE_RESOURCES / "couverture.png"
PAGE_TEMPLATE_IMAGE = GUIDE_RESOURCES / "page_modele.png"

ACTIVITY_LABELS = {
    "auditory": ("التمييز السمعي", "Auditory discrimination"),
    "sound_id": ("تحديد الصوت", "Sound identification"),
    "word_build": ("بناء الكلمة", "Word building"),
    "word_fix": ("تصحيح الكلمة", "Word correction"),
    "read_compare": ("القراءة والمقارنة", "Reading and comparison"),
    "sentence_build": ("بناء الجملة", "Sentence building"),
    "guided_read": ("إعادة القراءة", "Guided rereading"),
    "review": ("المراجعة الشاملة", "Whole review"),
}
ACTIVITY_FAMILY_LABELS = {
    "auditory_discrimination": ACTIVITY_LABELS["auditory"],
    "phoneme_grapheme_matching": ACTIVITY_LABELS["sound_id"],
    "letter_ordering": ACTIVITY_LABELS["word_build"],
    "missing_letter": ACTIVITY_LABELS["word_fix"],
    "guided_reading": ACTIVITY_LABELS["guided_read"],
    "syllable_ordering": ACTIVITY_LABELS["sentence_build"],
    "extra_phoneme_detection": ("كشف الصوت الزائد", "Extra phoneme detection"),
}
ERROR_LABELS = {
    "omission": ("حذف", "Omission"), "insertion": ("إضافة", "Insertion"),
    "addition": ("إضافة", "Addition"), "substitution": ("استبدال", "Substitution"),
    "inversion": ("قلب", "Inversion"),
    "consonant_substitution": ("استبدال صامت", "Consonant substitution"),
    "short_vowel_confusion": ("التباس حركة قصيرة", "Short-vowel confusion"),
    "long_vowel_confusion": ("التباس مد", "Long-vowel confusion"),
}
REMARK_COLORS = {
    "omission": colors.HexColor("#B64252"),
    "insertion": ORANGE, "addition": ORANGE,
    "inversion": colors.HexColor("#7354A6"),
    "consonant_substitution": BLUE, "substitution": BLUE,
    "short_vowel_confusion": TEAL, "long_vowel_confusion": TEAL,
}


def _font_path() -> Path:
    configured = os.getenv("ACODYSLEX_PDF_FONT_PATH", "").strip()
    candidates = [Path(configured)] if configured else []
    candidates += [
        Path("C:/Windows/Fonts/arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError("No Arabic-capable font found; set ACODYSLEX_PDF_FONT_PATH.")


def _register_fonts() -> tuple[str, str]:
    regular, bold = "AcoGuide", "AcoGuideBold"
    if regular not in pdfmetrics.getRegisteredFontNames():
        path = _font_path()
        pdfmetrics.registerFont(TTFont(regular, str(path)))
        bold_path = path.with_name("arialbd.ttf") if path.name.lower() == "arial.ttf" else path
        pdfmetrics.registerFont(TTFont(bold, str(bold_path if bold_path.is_file() else path)))
    return regular, bold


def rtl(value: object) -> str:
    """Shape Arabic and apply bidirectional ordering before ReportLab draws it."""
    text = str(value or "")
    return get_display(arabic_reshaper.reshape(text)) if any("\u0600" <= c <= "\u06ff" for c in text) else text


def text(value: object, lang: str) -> str:
    return rtl(value) if lang == "ar" else str(value or "")


def report_context(session_id: str) -> dict:
    """Read only the selected session and its owning profile from SQLite."""
    connection = progress_service.connect()
    try:
        row = connection.execute("SELECT * FROM learning_sessions WHERE session_id = ?", (session_id,)).fetchone()
        if row is None:
            raise KeyError("session not found")
        session = progress_service._session_dict(connection, row)
        profile = progress_service.get_profile(row["child_id"])
        analysis_row = connection.execute(
            """SELECT result_json FROM batch_analyses WHERE session_id = ? AND result_json IS NOT NULL
               ORDER BY updated_at DESC LIMIT 1""", (session_id,)
        ).fetchone()
        analysis = __import__("json").loads(analysis_row["result_json"]) if analysis_row else {}
        history_rows = connection.execute(
            "SELECT * FROM learning_sessions WHERE child_id = ? ORDER BY started_at, session_id",
            (row["child_id"],),
        ).fetchall()
        history = [progress_service._session_dict(connection, item) for item in history_rows]
        prior = sum(1 for item in history if item["session_id"] != session_id and item["started_at"] < session["started_at"])
        mastery_events = [dict(item) for item in connection.execute(
            """SELECT skill, previous_mastery, resulting_mastery, effective_performance,
                      evidence_added, created_at
               FROM skill_progress_events
               WHERE child_id = ? ORDER BY created_at, event_id""",
            (row["child_id"],),
        )]
        exercises = [progress_service.EXERCISES[item] for item in session["recommended_exercise_ids"] if item in progress_service.EXERCISES]
        return {"profile": profile, "session": session, "analysis": analysis, "prior_sessions": prior, "exercises": exercises, "history": history, "mastery_events": mastery_events}
    finally:
        connection.close()


class WaveArtwork(Flowable):
    def __init__(self, width=440, height=92):
        super().__init__(); self.width = width; self.height = height

    def draw(self):
        canvas = self.canv
        baseline = self.height / 2
        for index, amplitude in enumerate((10, 23, 38, 22, 45, 30, 14, 32, 19, 9)):
            x = 16 + index * 42
            canvas.setStrokeColor(TEAL if index % 2 else BLUE); canvas.setLineWidth(5)
            canvas.line(x, baseline - amplitude, x, baseline + amplitude)
        canvas.setFillColor(BLUE); canvas.roundRect(self.width - 104, 20, 78, 54, 12, stroke=0, fill=1)
        canvas.setFillColor(colors.white); canvas.setFont("Helvetica-Bold", 31); canvas.drawCentredString(self.width - 65, 35, "A")


class GuideDoc(BaseDocTemplate):
    def __init__(self, stream, title: str, font: str, **kwargs):
        super().__init__(stream, pagesize=A4, leftMargin=16*mm, rightMargin=16*mm, topMargin=17*mm, bottomMargin=16*mm, **kwargs)
        self.guide_title = title; self.guide_font = font
        frame = Frame(self.leftMargin, self.bottomMargin, PAGE_WIDTH-self.leftMargin-self.rightMargin, PAGE_HEIGHT-self.topMargin-self.bottomMargin, id="normal")
        self.addPageTemplates([__import__("reportlab.platypus", fromlist=["PageTemplate"]).PageTemplate(id="guide", frames=[frame], onPage=self._header_footer)])

    def _header_footer(self, canvas, doc):
        if doc.page > 1:
            canvas.saveState(); canvas.setStrokeColor(colors.HexColor("#DCE6F2")); canvas.line(16*mm, PAGE_HEIGHT-12*mm, PAGE_WIDTH-16*mm, PAGE_HEIGHT-12*mm)
            canvas.setFillColor(MUTED); canvas.setFont(self.guide_font, 7); canvas.drawString(16*mm, PAGE_HEIGHT-9*mm, "AcoDyslex")
            canvas.drawRightString(PAGE_WIDTH-16*mm, 9*mm, f"{doc.page}")
            canvas.restoreState()


def _styles(font: str, bold: str, lang: str) -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    direction = TA_RIGHT if lang == "ar" else TA_LEFT
    return {
        "cover": ParagraphStyle("cover", parent=base["Title"], fontName=bold, fontSize=27, leading=34, textColor=NAVY, alignment=TA_RIGHT if lang == "ar" else TA_LEFT, spaceAfter=8),
        "h1": ParagraphStyle("h1", parent=base["Heading1"], fontName=bold, fontSize=19, leading=26, textColor=NAVY, alignment=direction, spaceBefore=3, spaceAfter=10),
        "h2": ParagraphStyle("h2", parent=base["Heading2"], fontName=bold, fontSize=12, leading=18, textColor=BLUE, alignment=direction, spaceBefore=7, spaceAfter=5),
        "body": ParagraphStyle("body", parent=base["BodyText"], fontName=font, fontSize=9.2, leading=15, textColor=INK, alignment=direction, spaceAfter=6),
        "small": ParagraphStyle("small", parent=base["BodyText"], fontName=font, fontSize=7.7, leading=11, textColor=MUTED, alignment=direction),
        "arabic": ParagraphStyle("arabic", parent=base["BodyText"], fontName=font, fontSize=15, leading=24, textColor=NAVY, alignment=TA_RIGHT, spaceAfter=5),
        "exercise": ParagraphStyle("exercise", parent=base["BodyText"], fontName=font, fontSize=10, leading=16, textColor=INK, alignment=direction),
    }


def p(value: object, style: ParagraphStyle, lang: str) -> Paragraph:
    safe = escape(text(value, lang)).replace("\n", "<br/>")
    return Paragraph(safe, style)


def _card(rows, styles, lang):
    table = Table([[p(label, styles["small"], lang), p(value, styles["body"], lang)] for label, value in rows], colWidths=[45*mm, 122*mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PALE), ("BOX", (0, 0), (-1, -1), .5, colors.HexColor("#D9E5F2")),
        ("INNERGRID", (0, 0), (-1, -1), .25, colors.HexColor("#D9E5F2")), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return table


def _chart(values: list[tuple[str, int]], title: str, font: str, lang: str) -> Drawing:
    drawing = Drawing(480, 155); drawing.add(Rect(0, 0, 480, 155, fillColor=PALE, strokeColor=colors.HexColor("#D9E5F2"), rx=12, ry=12))
    drawing.add(String(15, 134, text(title, lang), fontName=font, fontSize=9, fillColor=INK))
    maximum = max([value for _, value in values] or [1]) or 1; width = 390 / max(len(values), 1)
    for index, (label, value) in enumerate(values):
        height = 78 * value / maximum; x = 34 + index * width
        drawing.add(Rect(x, 34, width*.55, height, fillColor=TEAL if index % 2 else BLUE, strokeColor=None))
        drawing.add(String(x, 19, text(label, lang)[:18], fontName=font, fontSize=6, fillColor=MUTED))
        drawing.add(String(x, 117, str(value), fontName=font, fontSize=8, fillColor=INK))
    return drawing


def _heading(label: str, styles, lang: str): return p(label, styles["h1"], lang)


def _session_date(value: str) -> str:
    try: return datetime.fromisoformat(value.replace("Z", "+00:00")).strftime("%Y-%m-%d")
    except ValueError: return value[:10]


def build_learning_guide(session_id: str, lang: str = "ar") -> bytes:
    if lang not in {"ar", "en"}: raise ValueError("lang must be ar or en")
    context = report_context(session_id); profile, session, analysis = context["profile"], context["session"], context["analysis"]
    font, bold = _register_fonts(); styles = _styles(font, bold, lang); stream = BytesIO()
    title = "الدليل التربوي الشخصي" if lang == "ar" else "Personalized Learning Guide"
    doc = GuideDoc(stream, title, font); story = []
    words = session["reading_words"]; word_count = sum(unit.get("unit_type") != "short_sentence" for unit in words); sentence_count = len(words)-word_count
    analyzed = [unit for unit in words if unit.get("analysis_status") == "ok"]
    candidates = [candidate for unit in words for candidate in unit.get("candidate_errors", [])]
    confirmed = [item for item in session["observations"] if item.get("verification_status") == "human_verified"]
    model_versions = analysis.get("model_versions") or {}
    model = model_versions.get("acoustic") or ("غير مسجل" if lang == "ar" else "Not recorded")
    model_revision = model_versions.get("acoustic_revision") or model_versions.get("revision") or ("غير مسجل" if lang == "ar" else "Not recorded")

    # 1. Cover
    story += [Spacer(1, 19*mm), WaveArtwork(), Spacer(1, 12*mm), p("AcoDyslex", styles["h2"], lang), p(title, styles["cover"], lang),
              p("دليل عملي لمرافقة القراءة العربية" if lang == "ar" else "A practical guide for supporting Arabic reading", styles["body"], lang), Spacer(1, 13*mm),
              _card([("الملف" if lang == "ar" else "Profile", profile.get("display_name") or ("متعلم مجهول" if lang == "ar" else "Pseudonymous learner")), ("تاريخ الجلسة" if lang == "ar" else "Session date", _session_date(session["started_at"])), ("التحليل الصوتي" if lang == "ar" else "Acoustic analysis", "Modal" if analysis else ("غير مسجل" if lang == "ar" else "Not recorded")), ("النموذج" if lang == "ar" else "Model", model), ("المراجعة" if lang == "ar" else "Revision", model_revision)], styles, lang), Spacer(1, 12*mm),
              p("الاقتراحات الصادرة عن الذكاء الاصطناعي مؤشرات صوتية تحتاج إلى مراجعة بشرية. التوصيات التربوية تعتمد فقط على الملاحظات التي أكدها المرافق والسجل التعلمي." if lang == "ar" else "AI output is an acoustic suggestion requiring human review. Pedagogical recommendations use confirmed observations and the learner's history.", styles["body"], lang), PageBreak()]

    # 2. Session
    story += [_heading("عرض الجلسة" if lang == "ar" else "Session overview", styles, lang),
              _card([("العمر" if lang == "ar" else "Age", profile.get("age") or "-"), ("الوحدات المقدمة" if lang == "ar" else "Presented units", str(len(words))), ("كلمات" if lang == "ar" else "Words", str(word_count)), ("جمل قصيرة" if lang == "ar" else "Short sentences", str(sentence_count)), ("جلسات سابقة" if lang == "ar" else "Previous sessions", str(context["prior_sessions"]))], styles, lang),
              _heading("المنهج" if lang == "ar" else "Method", styles, lang), p("تم عرض وحدات قراءة قصيرة، ثم أُجري تحليل صوتي جماعي عند توفر التسجيلات. لا يُفسّر أي فرق صوتي بوصفه خطأً مؤكداً إلا بعد مراجعة المرافق." if lang == "ar" else "Short reading units were presented, followed by grouped acoustic analysis when recordings were available. No acoustic difference is treated as a confirmed error without companion review.", styles["body"], lang),
              _heading("المواد المقروءة" if lang == "ar" else "Reading material", styles, lang)]
    for unit in words: story.append(p(f"{unit.get('order','')}. {unit.get('text','')}", styles["arabic"], "ar"))
    story.append(PageBreak())

    # 3. Statistics
    story += [_heading("إحصاءات الجلسة" if lang == "ar" else "Session statistics", styles, lang), _chart([("Words", word_count), ("Sentences", sentence_count), ("Analyzed", len(analyzed)), ("Candidates", len(candidates)), ("Confirmed", len(confirmed))], "بيانات الجلسة" if lang == "ar" else "Session data", font, lang),
              p("مصدر البيانات: قاعدة بيانات الجلسة المحلية. عدد الكلمات المقدمة لا يعني عدد الكلمات الصحيحة." if lang == "ar" else "Data source: local session database. Presented words are not a count of correctly read words.", styles["small"], lang),
              _heading("نتائج الأنشطة" if lang == "ar" else "Activity results", styles, lang)]
    attempts = session["attempts"]; correct = sum(item["correct_count"] for item in attempts); total = sum(item["total_count"] for item in attempts)
    story += [_card([("محاولات محفوظة" if lang == "ar" else "Saved attempts", str(len(attempts))), ("استجابات صحيحة" if lang == "ar" else "Correct responses", f"{correct} / {total}" if total else ("بيانات غير كافية" if lang == "ar" else "Insufficient data")), ("المساعدة المستخدمة" if lang == "ar" else "Help used", str(sum(bool(item.get("help_used")) for item in attempts)))], styles, lang), PageBreak()]

    # 4. Acoustic analysis
    story += [_heading("التحليل الصوتي والفونيمي" if lang == "ar" else "Acoustic and phonemic analysis", styles, lang), p("النموذج الصوتي: " + str(model), styles["body"], lang)]
    if not analyzed:
        story.append(p("بيانات غير كافية: لا توجد نتيجة تحليل صوتي مكتملة لهذه الجلسة." if lang == "ar" else "Insufficient data: no completed acoustic analysis is stored for this session.", styles["body"], lang))
    for unit in analyzed[:5]:
        expected = "  ".join(unit.get("expected_phonemes") or []) or "-"; observed = unit.get("observed_text") or "-"; story += [p(unit.get("text", ""), styles["arabic"], "ar"), _card([("الفونيمات المتوقعة" if lang == "ar" else "Expected phonemes", expected), ("ناتج النموذج" if lang == "ar" else "Model output", observed), ("الحالة" if lang == "ar" else "Status", unit.get("analysis_status") or "-")], styles, lang)]
    story += [p("تستخدم المراجع الفونيمية محرك G2P: " + G2P_VERSION, styles["small"], lang), PageBreak()]

    # 5. Pedagogical summary
    by_type = Counter(item.get("error_type") for item in confirmed if item.get("error_type")); labels = [(ERROR_LABELS.get(key, (key, key))[0 if lang == "ar" else 1], value) for key, value in by_type.items()]
    story += [_heading("الخلاصة التربوية" if lang == "ar" else "Pedagogical summary", styles, lang)]
    if labels: story += [_chart(labels, "الملاحظات التي أكدها المرافق" if lang == "ar" else "Companion-confirmed observations", font, lang), p("هذه الملاحظات هي وحدها التي تستخدم في التوصيات. وهي مؤشرات تربوية وليست تشخيصاً طبياً." if lang == "ar" else "Only these observations inform recommendations. They are pedagogical indicators, not a medical diagnosis.", styles["body"], lang)]
    else: story.append(p("لا توجد ملاحظات مؤكدة لهذه الجلسة. لا تُستنتج صعوبة مؤكدة من اقتراح نموذج صوتي فقط." if lang == "ar" else "No confirmed observation is stored for this session. A model suggestion alone does not establish a difficulty.", styles["body"], lang))
    story += [_heading("نقاط القوة" if lang == "ar" else "Strengths", styles, lang), p("الاستمرار في المحاولة وتوثيق الأنشطة المكتملة مؤشرات مفيدة للمرافق." if lang == "ar" else "Continued participation and saved completed activities provide useful support signals.", styles["body"], lang), PageBreak()]

    # 6. Paper exercises
    story += [_heading("تمارين شخصية للطباعة" if lang == "ar" else "Personalized printable exercises", styles, lang)]
    if not context["exercises"]: story.append(p("لا توجد تمارين موصى بها محفوظة بعد. أكمل مراجعة التقرير أولاً." if lang == "ar" else "No saved recommended exercises yet. Complete report review first.", styles["body"], lang))
    for index, exercise in enumerate(context["exercises"], 1):
        material = exercise.get("material") or {}; entries = material.get("items") or material.get("cards") or material.get("options") or [material.get("spoken_word") or ""]
        activity_ar, activity_en = ACTIVITY_FAMILY_LABELS.get(
            exercise.get("activity_family"), ACTIVITY_LABELS["review"]
        )
        title = activity_ar if lang == "ar" else activity_en; prompt = exercise.get("instruction_ar") or ""
        answer = material.get("answer") or " · ".join(material.get("expected_order") or []) or "-"
        content = "   ".join(str(item) for item in entries if item)
        panel = [p(f"{index}. {title}", styles["h2"], lang), p(prompt, styles["exercise"], "ar"), p(content, styles["arabic"], "ar"), p("□ " + ("تم الإنجاز" if lang == "ar" else "Completed"), styles["small"], lang), p(("تصحيح للمرافق: " if lang == "ar" else "Companion correction: ") + str(answer), styles["small"], lang), Spacer(1, 7*mm)]
        story.append(KeepTogether(panel))
    story.append(PageBreak())

    # 7. Home practice
    story += [_heading("مراجعة منزلية" if lang == "ar" else "Home practice", styles, lang), p("خطة قصيرة قابلة للتكرار. توقف إذا ظهر تعب، واختر وقتاً هادئاً." if lang == "ar" else "A short repeatable plan. Pause if fatigue appears and choose a calm moment.", styles["body"], lang)]
    home_rows = [[p("اليوم" if lang == "ar" else "Day", styles["small"], lang), p("نشاط قصير" if lang == "ar" else "Short activity", styles["small"], lang), p("متابعة" if lang == "ar" else "Check", styles["small"], lang)]]
    for number, activity in enumerate(("التمييز السمعي", "بناء الكلمة", "إعادة القراءة", "المراجعة الشاملة", "القراءة والمقارنة"), 1): home_rows.append([p(str(number), styles["body"], lang), p(activity, styles["body"], "ar"), p("□", styles["body"], lang)])
    table = Table(home_rows, colWidths=[25*mm, 125*mm, 17*mm]); table.setStyle(TableStyle([("BACKGROUND", (0,0),(-1,0), colors.HexColor("#E8F1FF")),("GRID",(0,0),(-1,-1),.4,colors.HexColor("#C9D9EC")),("VALIGN",(0,0),(-1,-1),"MIDDLE"),("TOPPADDING",(0,0),(-1,-1),7),("BOTTOMPADDING",(0,0),(-1,-1),7)])); story += [table, Spacer(1, 9*mm), p("يُفضّل تسجيل ملاحظات قصيرة عن المساعدة المطلوبة، لا عن التشخيص." if lang == "ar" else "Record short notes about support needed, not diagnoses.", styles["body"], lang), PageBreak()]

    # 8. Technology and limits
    story += [_heading("التقنية والحدود" if lang == "ar" else "Technology and limits", styles, lang), p("يُشغّل Modal التحليل الصوتي عندما تتوفر بياناته في الجلسة. النموذج المسجل لهذه الجلسة هو: " + str(model), styles["body"], lang),
              p("المراجع الفونيمية تُنشأ عبر G2P، ثم تُقارن تسلسلات متوقعة ومخرجات صوتية. لا تعني المطابقة أو عدم المطابقة وحدها حكماً نهائياً على قراءة الطفل." if lang == "ar" else "G2P generates phoneme references, then expected sequences are compared with acoustic output. A match or mismatch alone is not a final judgement about a child's reading.", styles["body"], lang),
              _heading("الخصوصية" if lang == "ar" else "Privacy", styles, lang), p("لا يتضمن هذا الدليل صوتاً خاماً أو صوراً شخصية أو معرفات تقنية. هذا النموذج مخصص لبيئة محلية أو خاصة حتى تتوفر المصادقة وضوابط الوصول." if lang == "ar" else "This guide contains no raw audio, personal photographs, or technical identifiers. This prototype is intended for a local or private environment until authentication and access controls are available.", styles["body"], lang),
              p("Meta Wav2Vec2/XLS-R لا تذكر إلا إذا كانت بيانات النموذج المخزنة في الجلسة تؤكدها؛ Meta ليست شريكاً أو راعياً لـ AcoDyslex." if lang == "ar" else "Meta Wav2Vec2/XLS-R is mentioned only when stored model metadata confirms it; Meta is not a partner or sponsor of AcoDyslex.", styles["body"], lang)]
    doc.build(story)
    return stream.getvalue()


# V0.6.2 printed guide.  The application uses a library of eight companion-led
# activities; the guide deliberately mirrors that library so a family can carry
# on without opening the application or recording audio.
PRINT_ACTIVITIES = (
    ("التمييز السمعي", "نميّز بين أصوات متقاربة بهدوء.", (
        ("استمع ثم اختر الصوت الذي تسمعه.", "سَ     صَ     شَ"),
        ("أي صوت يختلف؟", "بَ     بَ     تَ"),
        ("اختر المقطع الطويل.", "بَ     بَا     بُ"),
        ("قل الصوتين ثم صف الفرق.", "سَ     صَ"),
    )),
    ("تحديد الصوت", "نبحث عن الصوت في بداية الكلمة أو وسطها أو آخرها.", (
        ("ما الصوت الأول في كلمة: باب؟", "ب     ا     بَ"),
        ("ما الصوت الأخير في كلمة: قمر؟", "ق     م     ر"),
        ("هل تسمع صوت م في كلمة: سمك؟", "نعم     لا"),
        ("اختر الحرف الذي تسمعه في: رَ.", "ر     ز     د"),
    )),
    ("بناء الكلمة", "نرتّب الحروف أو المقاطع لبناء كلمة.", (
        ("رتّب الحروف لتكوّن كلمة.", "ب     ا     ب"),
        ("رتّب الحروف لتكوّن كلمة.", "ت     ك     ا     ب"),
        ("رتّب المقاطع لتكوّن كلمة.", "مَ     دْ     رَ     سَ     ة"),
        ("رتّب الحروف لتكوّن كلمة.", "س     م     ك"),
    )),
    ("تصحيح الكلمة", "نلاحظ الخطأ ثم نصلح الكلمة.", (
        ("اختر الحرف الناقص: مـ_ـرسة", "د     ر     س"),
        ("أي كلمة صحيحة؟", "كتبـا     كتاب     كبتا"),
        ("اختر الصوت الذي نستبدله في: سَ / صَ.", "س     ص     م"),
        ("رتّب الحروف لتكوين كلمة.", "ق     ل     م"),
    )),
    ("القراءة والمقارنة", "نقارن كلمات متقاربة ونقرأ الفرق.", (
        ("أي كلمتين تختلفان في الحرف الأول؟", "دار / نار     باب / باب     قلم / قلم"),
        ("اختر الكلمة التي فيها ر.", "دار     باب     سمك"),
        ("اقرأ الكلمتين ببطء.", "سار     صار"),
        ("اقرأ الكلمتين ثم صف الفرق.", "كَتَبَ     كاتَبَ"),
    )),
    ("بناء الجملة", "نرتّب كلمتين أو ثلاث كلمات في جملة قصيرة.", (
        ("رتّب الكلمات.", "كتاب     هذا"),
        ("رتّب الكلمات.", "الولد     قرأ     كتاباً"),
        ("رتّب الكلمات.", "إلى     ذهب     السوق"),
        ("اختر الكلمة الناقصة: هذا ___.", "كتاب     قرأ     إلى"),
    )),
    ("إعادة القراءة", "نقرأ من جديد ببطء وثقة.", (
        ("اقرأ الكلمتين بوضوح.", "باب     قلم"),
        ("اقرأ الجملة ببطء.", "هذا كتاب"),
        ("اقرأ الجملة ببطء.", "قرأ الولد"),
        ("اقرأ الجملة ببطء.", "ذهب الولد إلى السوق"),
    )),
    ("المراجعة الشاملة", "نراجع 16 تمريناً متنوعاً من الأنشطة السابقة.", ()),
)

# La fiche de « révision générale » de 16 items n'est plus exportée : le guide
# ne garde que les activités imprimables réellement proposées aux familles.
PRINTABLE_ACTIVITIES = PRINT_ACTIVITIES[:-1]


def _guide_paragraph(canvas_obj, value: str, style: ParagraphStyle, x: float, y: float, width: float, lang: str) -> float:
    """Draw one shaped paragraph and return the next y position."""
    block = p(value, style, lang)
    _, height = block.wrap(width, 1000)
    block.drawOn(canvas_obj, x, y - height)
    return y - height


def _guide_footer(canvas_obj, page: int, total: int, font: str) -> None:
    # The supplied template contains a footer capsule; this dynamic label makes
    # the printed page number correct regardless of the number of activities.
    canvas_obj.saveState()
    canvas_obj.setFillColor(colors.white)
    # Cover the fixed "1 of 8" baked into page_modele.png before drawing the
    # real counter for this specific guide.
    capsule_x, capsule_y = PAGE_WIDTH - 69 * mm, 3 * mm
    capsule_width, capsule_height = 63 * mm, 21 * mm
    canvas_obj.roundRect(capsule_x, capsule_y, capsule_width, capsule_height, 8 * mm, stroke=0, fill=1)
    canvas_obj.setFillColor(NAVY)
    font_size = 11
    canvas_obj.setFont(font, font_size)
    # ReportLab positions text from its baseline.  Use the font ascender and
    # descender so the glyphs, not merely the baseline, are centred.
    ascent, descent = pdfmetrics.getAscentDescent(font, font_size)
    baseline = capsule_y + capsule_height / 2 - (ascent + descent) / 2
    canvas_obj.drawCentredString(capsule_x + capsule_width / 2, baseline, rtl(f"صفحة {page} من {total}"))
    canvas_obj.restoreState()


def _guide_page(canvas_obj, template: ImageReader, page: int, total: int, font: str) -> None:
    canvas_obj.drawImage(template, 0, 0, width=PAGE_WIDTH, height=PAGE_HEIGHT, mask="auto")
    _guide_footer(canvas_obj, page, total, font)


def _draw_child_vector(canvas_obj, x: float, y: float, sex: str = "unspecified") -> None:
    """Draw a same-size, colourful learner vector without using a photo."""
    canvas_obj.saveState()
    is_female = sex == "female"
    canvas_obj.setFillColor(colors.HexColor("#FDEBF4") if is_female else colors.HexColor("#DDF5F3")); canvas_obj.circle(x, y, 42 * mm, stroke=0, fill=1)
    # Hair is drawn first to frame the face.  Both variants retain identical
    # dimensions and visual weight, so the profile layout never changes.
    hair = colors.HexColor("#443452") if is_female else colors.HexColor("#25364A")
    canvas_obj.setFillColor(hair)
    if is_female:
        canvas_obj.circle(x, y + 14 * mm, 15 * mm, stroke=0, fill=1)
        canvas_obj.circle(x + 13 * mm, y + 10 * mm, 7 * mm, stroke=0, fill=1)
    else:
        canvas_obj.roundRect(x - 13 * mm, y + 14 * mm, 26 * mm, 13 * mm, 7 * mm, stroke=0, fill=1)
    canvas_obj.setFillColor(colors.HexColor("#F7C9A8")); canvas_obj.circle(x, y + 13 * mm, 11.7 * mm, stroke=0, fill=1)
    canvas_obj.setFillColor(colors.HexColor("#25364A")); canvas_obj.circle(x - 4.4 * mm, y + 16 * mm, 1.25 * mm, stroke=0, fill=1); canvas_obj.circle(x + 4.4 * mm, y + 16 * mm, 1.25 * mm, stroke=0, fill=1)
    canvas_obj.setStrokeColor(colors.HexColor("#A95D55")); canvas_obj.setLineWidth(1.1); canvas_obj.line(x - 2.5 * mm, y + 8.5 * mm, x + 2.5 * mm, y + 8.5 * mm)
    canvas_obj.setFillColor(colors.HexColor("#7B62C5") if is_female else BLUE); canvas_obj.roundRect(x - 18 * mm, y - 25 * mm, 36 * mm, 29 * mm, 8 * mm, stroke=0, fill=1)
    canvas_obj.setFillColor(colors.HexColor("#B06C95") if is_female else TEAL); canvas_obj.roundRect(x - 27 * mm, y - 18 * mm, 54 * mm, 22 * mm, 3 * mm, stroke=0, fill=1)
    canvas_obj.setStrokeColor(colors.white); canvas_obj.setLineWidth(1.2); canvas_obj.line(x, y - 18 * mm, x, y + 4 * mm)
    canvas_obj.restoreState()


def _profile_page(canvas_obj, template: ImageReader, context: dict, page: int, total: int, styles: dict, font: str, lang: str) -> None:
    _guide_page(canvas_obj, template, page, total, font)
    profile, session = context["profile"], context["session"]
    title = "بطاقة المتعلم" if lang == "ar" else "Learner profile"
    y = _guide_paragraph(canvas_obj, title, styles["h1"], 28 * mm, 225 * mm, 150 * mm, lang)
    _draw_child_vector(canvas_obj, 53 * mm, 150 * mm, profile.get("sex") or "unspecified")
    canvas_obj.setFillColor(colors.HexColor("#F4FAFC")); canvas_obj.roundRect(87 * mm, 110 * mm, 91 * mm, 78 * mm, 5 * mm, stroke=0, fill=1)
    rows = (
        ("الاسم" if lang == "ar" else "Name", profile.get("display_name") or ("متعلم" if lang == "ar" else "Learner")),
        ("العمر" if lang == "ar" else "Age", str(profile.get("age") or "-")),
        ("تاريخ الجلسة" if lang == "ar" else "Session date", _session_date(session["started_at"])),
        ("أنشطة الدليل" if lang == "ar" else "Guide activities", str(len(PRINTABLE_ACTIVITIES))),
    )
    row_y = 173 * mm
    for label, value in rows:
        canvas_obj.setFillColor(MUTED); canvas_obj.setFont(font, 8); canvas_obj.drawRightString(170 * mm, row_y, rtl(label) if lang == "ar" else label)
        canvas_obj.setFillColor(NAVY); canvas_obj.setFont(font, 11); canvas_obj.drawRightString(170 * mm, row_y - 7 * mm, rtl(value) if lang == "ar" else value)
        canvas_obj.setStrokeColor(colors.HexColor("#D9E5F2")); canvas_obj.line(92 * mm, row_y - 10 * mm, 170 * mm, row_y - 10 * mm)
        row_y -= 18 * mm
    note = "هذا الدليل موجّه إلى الآباء والأمهات والمرافقين التربويين لمساعدتهم على تنفيذ الأنشطة التعليمية مع الطفل. يتولى الوالد أو المرافق قراءة التعليمات وتقديم النماذج بصوت واضح ومسموع، ثم يستمع إلى قراءة الطفل، ويشجّعه، ويقدّم له المساعدة عند الحاجة، مع تدوين الملاحظات المناسبة حول أدائه وتقدّمه." if lang == "ar" else "This guide is for parents, caregivers, and educational companions to help them carry out learning activities with the child. The parent or companion reads the instructions and presents clear spoken models, then listens to the child, encourages them, provides help when needed, and records appropriate observations about their performance and progress."
    emphasis = "لا يتطلب تنفيذ هذه الأنشطة تسجيل صوت الطفل داخل التطبيق، إذ يمكن إنجازها مباشرة بمرافقة الوالد أو المرافق التربوي." if lang == "ar" else "These activities do not require recording the child's voice in the app; they can be completed directly with a parent or educational companion."
    note_style = ParagraphStyle("profile-note", parent=styles["body"], fontSize=9.8, leading=13.8, alignment=TA_RIGHT if lang == "ar" else TA_LEFT)
    emphasis_style = ParagraphStyle("profile-note-emphasis", parent=note_style, fontName=styles["h2"].fontName, textColor=NAVY)
    canvas_obj.setFillColor(colors.HexColor("#E8F6F5")); canvas_obj.roundRect(28 * mm, 27 * mm, 150 * mm, 78 * mm, 5 * mm, stroke=0, fill=1)
    note_y = _guide_paragraph(canvas_obj, note, note_style, 34 * mm, 99 * mm, 138 * mm, lang)
    _guide_paragraph(canvas_obj, emphasis, emphasis_style, 34 * mm, note_y - 3.5 * mm, 138 * mm, lang)


def _task_box(canvas_obj, prompt: str, options: str, index: int, x: float, y: float, width: float, height: float, styles: dict) -> None:
    canvas_obj.saveState()
    canvas_obj.setFillColor(colors.white); canvas_obj.setStrokeColor(colors.HexColor("#CDE6EA")); canvas_obj.roundRect(x, y - height, width, height, 4 * mm, stroke=1, fill=1)
    canvas_obj.setFillColor(TEAL); canvas_obj.roundRect(x + width - 11 * mm, y - height, 11 * mm, height, 4 * mm, stroke=0, fill=1)
    canvas_obj.setFillColor(colors.white); canvas_obj.setFont(styles["h2"].fontName, 10); canvas_obj.drawCentredString(x + width - 5.5 * mm, y - 15.8 * mm, str(index))
    _guide_paragraph(canvas_obj, prompt, styles["exercise"], x + 7 * mm, y - 6 * mm, width - 24 * mm, "ar")
    canvas_obj.setFillColor(NAVY); canvas_obj.setFont(styles["arabic"].fontName, 13); canvas_obj.drawRightString(x + width - 17 * mm, y - 17 * mm, rtl(options))
    canvas_obj.setFillColor(MUTED); canvas_obj.setFont(styles["small"].fontName, 7.3); canvas_obj.drawRightString(x + width - 17 * mm, y - height + 7 * mm, rtl("نتيجة المرافق:  □ مستقلة   □ بمساعدة   □ نعيد المحاولة"))
    canvas_obj.restoreState()


ACTIVITY_VISUALS = (
    ("#256EC8", "#E8F1FF", "ear"), ("#167D89", "#E7F4F4", "target"),
    ("#7B62C5", "#F0ECFB", "blocks"), ("#C06B37", "#F8EEE8", "pencil"),
    ("#167D89", "#E7F4F4", "compare"), ("#7B62C5", "#F0ECFB", "sentence"),
    ("#3C9872", "#E8F5EE", "book"), ("#AA668D", "#F7EBF1", "spark"),
)


def _activity_icon(canvas_obj, kind: str, x: float, y: float, color: colors.Color) -> None:
    """Draw the same semantic vectors used by the activity library, as PDF paths."""
    canvas_obj.saveState(); canvas_obj.setStrokeColor(color); canvas_obj.setFillColor(color); canvas_obj.setLineWidth(2.2)
    if kind == "ear":
        canvas_obj.circle(x, y, 5, stroke=1, fill=0); canvas_obj.line(x + 5, y, x + 9, y + 6); canvas_obj.line(x + 9, y + 6, x + 7, y + 11)
    elif kind == "target":
        canvas_obj.circle(x, y, 9, stroke=1, fill=0); canvas_obj.circle(x, y, 4, stroke=1, fill=0); canvas_obj.circle(x, y, 1.5, stroke=0, fill=1)
    elif kind == "blocks":
        for dx, dy in ((-7, 6), (3, 6), (-7, -4), (3, -4)): canvas_obj.rect(x + dx, y + dy, 6, 6, stroke=0, fill=1)
    elif kind == "pencil":
        canvas_obj.saveState(); canvas_obj.translate(x, y); canvas_obj.rotate(45); canvas_obj.roundRect(-3, -10, 6, 18, 1, stroke=0, fill=1); canvas_obj.restoreState()
    elif kind == "compare":
        canvas_obj.line(x - 9, y + 6, x + 5, y + 6); canvas_obj.line(x + 5, y + 6, x + 1, y + 10); canvas_obj.line(x + 5, y + 6, x + 1, y + 2)
        canvas_obj.line(x + 9, y - 6, x - 5, y - 6); canvas_obj.line(x - 5, y - 6, x - 1, y - 10); canvas_obj.line(x - 5, y - 6, x - 1, y - 2)
    elif kind == "sentence":
        for dy, length in ((7, 16), (0, 11), (-7, 14)): canvas_obj.line(x - 8, y + dy, x - 8 + length, y + dy)
    elif kind == "book":
        canvas_obj.roundRect(x - 10, y - 8, 9, 16, 1, stroke=1, fill=0); canvas_obj.roundRect(x + 1, y - 8, 9, 16, 1, stroke=1, fill=0); canvas_obj.line(x, y - 9, x, y + 9)
    else:
        canvas_obj.setLineWidth(1.7); canvas_obj.line(x - 10, y, x + 10, y); canvas_obj.line(x, y - 10, x, y + 10); canvas_obj.line(x - 6, y - 6, x + 6, y + 6); canvas_obj.line(x - 6, y + 6, x + 6, y - 6)
    canvas_obj.restoreState()


def _activity_summary_card(canvas_obj, activity: tuple, position: int, x: float, y: float, width: float, height: float, styles: dict, font: str) -> None:
    title, objective, tasks = activity; color_hex, pale_hex, icon = ACTIVITY_VISUALS[position]
    accent, pale = colors.HexColor(color_hex), colors.HexColor(pale_hex)
    total = len(tasks)
    canvas_obj.saveState(); canvas_obj.setFillColor(colors.white); canvas_obj.setStrokeColor(colors.HexColor("#D6E4F2")); canvas_obj.roundRect(x, y - height, width, height, 5 * mm, stroke=1, fill=1)
    canvas_obj.setFillColor(pale); canvas_obj.roundRect(x + width - 17 * mm, y - 17 * mm, 12 * mm, 12 * mm, 4 * mm, stroke=0, fill=1)
    _activity_icon(canvas_obj, icon, x + width - 11 * mm, y - 11 * mm, accent)
    canvas_obj.setFillColor(colors.HexColor("#F0F5FA")); canvas_obj.roundRect(x + 5 * mm, y - 14 * mm, 15 * mm, 6 * mm, 3 * mm, stroke=0, fill=1)
    canvas_obj.setFillColor(MUTED); canvas_obj.setFont(font, 6.8); canvas_obj.drawCentredString(x + 12.5 * mm, y - 12 * mm, rtl(f"{total} تمارين"))
    canvas_obj.setFillColor(NAVY); canvas_obj.setFont(styles["h2"].fontName, 12); canvas_obj.drawRightString(x + width - 5 * mm, y - 24 * mm, rtl(title))
    _guide_paragraph(canvas_obj, objective, ParagraphStyle("activity-summary", parent=styles["small"], fontSize=7.2, leading=9.5, alignment=TA_RIGHT, textColor=MUTED), x + 5 * mm, y - 31 * mm, width - 10 * mm, "ar")
    canvas_obj.setFillColor(accent); canvas_obj.roundRect(x + 5 * mm, y - height + 5 * mm, width - 10 * mm, 3 * mm, 1.5 * mm, stroke=0, fill=1)
    canvas_obj.restoreState()


def _activities_summary_page(canvas_obj, template: ImageReader, page: int, total: int, styles: dict, font: str, lang: str) -> None:
    _guide_page(canvas_obj, template, page, total, font)
    _guide_paragraph(canvas_obj, "ملخص الأنشطة" if lang == "ar" else "Activity summary", styles["h1"], 28 * mm, 225 * mm, 150 * mm, lang)
    intro = "يختار الوالد أو المرافق النشاط المناسب، ويقود التمرين مع الطفل بهدوء. كل نشاط مستقل ويمكن الرجوع إليه في أي وقت." if lang == "ar" else "The parent or companion selects the appropriate activity and leads it calmly with the learner. Each activity is independent and can be revisited at any time."
    _guide_paragraph(canvas_obj, intro, styles["body"], 28 * mm, 213 * mm, 150 * mm, lang)
    card_width, card_height = 47 * mm, 45 * mm
    positions = ((28 * mm, 194 * mm), (81.5 * mm, 194 * mm), (135 * mm, 194 * mm), (28 * mm, 143 * mm), (81.5 * mm, 143 * mm), (135 * mm, 143 * mm), (81.5 * mm, 92 * mm))
    for index, activity in enumerate(PRINTABLE_ACTIVITIES):
        x, y = positions[index]
        _activity_summary_card(canvas_obj, activity, index, x, y, card_width, card_height, styles, font)


def _activity_page(canvas_obj, template: ImageReader, activity: tuple, index: int, page: int, total: int, styles: dict, font: str, lang: str) -> None:
    _guide_page(canvas_obj, template, page, total, font)
    title, objective, tasks = activity
    if lang == "en":
        title = ACTIVITY_LABELS.get(("auditory", "sound_id", "word_build", "word_fix", "read_compare", "sentence_build", "guided_read", "review")[index - 1], (title, title))[1]
    _guide_paragraph(canvas_obj, f"{index}. {title}", styles["h1"], 28 * mm, 224 * mm, 150 * mm, lang)
    canvas_obj.setFillColor(colors.HexColor("#E8F6F5")); canvas_obj.roundRect(28 * mm, 190 * mm, 150 * mm, 19 * mm, 4 * mm, stroke=0, fill=1)
    _guide_paragraph(canvas_obj, objective, styles["body"], 34 * mm, 204 * mm, 138 * mm, "ar")
    for task_index, (prompt, options) in enumerate(tasks, 1):
        _task_box(canvas_obj, prompt, options, task_index, 28 * mm, (183 - (task_index - 1) * 34) * mm, 150 * mm, 29 * mm, styles)


def _closing_page(canvas_obj, page: int, total: int, font: str, bold: str, lang: str) -> None:
    canvas_obj.saveState()
    canvas_obj.setFillColor(NAVY); canvas_obj.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, stroke=0, fill=1)
    canvas_obj.setFillColor(colors.white); canvas_obj.setFont(bold, 20)
    canvas_obj.drawCentredString(PAGE_WIDTH / 2, PAGE_HEIGHT / 2 + 12, rtl("قراءة داعمة، خطوة بخطوة •" if lang == "ar" else "Supportive reading, step by step •"))
    canvas_obj.setFont(bold, 19)
    canvas_obj.drawCentredString(PAGE_WIDTH / 2, PAGE_HEIGHT / 2 - 18, "AcoDyslex")
    canvas_obj.restoreState()


# ----- Part 1: data-grounded session report ---------------------------------

def _label(lang: str, ar: str, en: str) -> str:
    return ar if lang == "ar" else en


def _safe_number(value: object) -> str:
    if isinstance(value, float):
        return f"{value:.2f}"
    return str(value) if value is not None else "-"


def _report_header(canvas_obj, template: ImageReader, page: int, total: int, styles: dict, font: str, lang: str, title: str, subtitle: str) -> None:
    _guide_page(canvas_obj, template, page, total, font)
    _guide_paragraph(canvas_obj, title, styles["h1"], 28 * mm, 225 * mm, 150 * mm, lang)
    _guide_paragraph(canvas_obj, subtitle, styles["small"], 28 * mm, 214 * mm, 150 * mm, lang)


def _report_box(canvas_obj, x: float, y: float, width: float, height: float, title: str, body: str, styles: dict, lang: str, color: colors.Color = BLUE) -> None:
    canvas_obj.saveState()
    canvas_obj.setFillColor(colors.white); canvas_obj.setStrokeColor(colors.HexColor("#D6E4F2"))
    canvas_obj.roundRect(x, y - height, width, height, 4 * mm, stroke=1, fill=1)
    canvas_obj.setFillColor(color); canvas_obj.roundRect(x, y - 7 * mm, width, 7 * mm, 4 * mm, stroke=0, fill=1)
    _guide_paragraph(canvas_obj, title, styles["h2"], x + 5 * mm, y - 12 * mm, width - 10 * mm, lang)
    _guide_paragraph(canvas_obj, body, styles["small"], x + 5 * mm, y - 23 * mm, width - 10 * mm, lang)
    canvas_obj.restoreState()


def _report_chart(canvas_obj, x: float, y: float, width: float, height: float, values: list[tuple[str, float]], title: str, styles: dict, font: str, lang: str, suffix: str = "%") -> None:
    canvas_obj.saveState()
    canvas_obj.setFillColor(PALE); canvas_obj.setStrokeColor(colors.HexColor("#D6E4F2")); canvas_obj.roundRect(x, y - height, width, height, 4 * mm, stroke=1, fill=1)
    _guide_paragraph(canvas_obj, title, styles["h2"], x + 5 * mm, y - 8 * mm, width - 10 * mm, lang)
    if not values:
        _guide_paragraph(canvas_obj, _label(lang, "بيانات غير كافية", "Insufficient data"), styles["body"], x + 5 * mm, y - height / 2, width - 10 * mm, lang)
        canvas_obj.restoreState(); return
    maximum = max(value for _, value in values) or 1
    chart_bottom, chart_height = y - height + 16 * mm, height - 42 * mm
    step = (width - 18 * mm) / max(len(values), 1)
    for index, (name, value) in enumerate(values):
        bar_height = chart_height * max(0, value) / maximum
        bar_x = x + 10 * mm + index * step
        canvas_obj.setFillColor(TEAL if index % 2 else BLUE)
        canvas_obj.roundRect(bar_x, chart_bottom, step * .5, bar_height, 1.5 * mm, stroke=0, fill=1)
        canvas_obj.setFillColor(INK); canvas_obj.setFont(font, 7)
        canvas_obj.drawCentredString(bar_x + step * .25, chart_bottom + bar_height + 3 * mm, f"{value:.0f}{suffix}")
        canvas_obj.setFillColor(MUTED); canvas_obj.setFont(font, 6.5)
        canvas_obj.drawCentredString(bar_x + step * .25, chart_bottom - 4 * mm, rtl(name) if lang == "ar" else name[:11])
    canvas_obj.restoreState()


def _analysis_units(context: dict) -> list[dict]:
    analysis_items = context.get("analysis", {}).get("word_results", [])
    by_id = {item.get("word_id"): item for item in analysis_items if isinstance(item, dict)}
    units = []
    for word in context["session"].get("reading_words", []):
        model = by_id.get(word.get("word_id"), {})
        units.append({**word, **model, "reference_text": model.get("reference_text") or word.get("text", "")})
    return units


def _candidate_type(item: dict) -> str:
    return str(item.get("error_type") or item.get("type") or "unknown")


def _unique_candidates(candidates: object) -> list[dict]:
    """Preserve distinct ASR suggestions while removing duplicate payloads."""
    if not isinstance(candidates, list):
        return []
    unique, seen = [], set()
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        signature = json.dumps(candidate, ensure_ascii=False, sort_keys=True, default=str)
        if signature in seen:
            continue
        seen.add(signature)
        unique.append(candidate)
    return unique


def _candidate_remark_types(candidates: object) -> list[str]:
    """Return each displayable candidate type once, in report order."""
    types, seen = [], set()
    for candidate in _unique_candidates(candidates):
        kind = _candidate_type(candidate)
        if kind not in seen:
            seen.add(kind)
            types.append(kind)
    return types


def _report_remark_bubbles(canvas_obj, kinds: list[str], x: float, y: float, width: float, font: str, lang: str) -> None:
    """Draw concise, color-coded ASR observation labels inside an analysis card."""
    if not kinds:
        return
    right, top, height = x + width - 5 * mm, y - 43 * mm, 6 * mm
    for kind in kinds:
        label = ERROR_LABELS.get(kind, (kind, kind))[0 if lang == "ar" else 1]
        text = _label(lang, f"ملاحظة: {label}", f"Observation: {label}")
        rendered = rtl(text) if lang == "ar" else text
        bubble_width = pdfmetrics.stringWidth(rendered, font, 8) + 8 * mm
        if right - bubble_width < x + 5 * mm:
            break
        canvas_obj.saveState()
        canvas_obj.setFillColor(REMARK_COLORS.get(kind, MUTED))
        canvas_obj.roundRect(right - bubble_width, top - height, bubble_width, height, 3 * mm, stroke=0, fill=1)
        canvas_obj.setFillColor(colors.white); canvas_obj.setFont(font, 8)
        canvas_obj.drawRightString(right - 4 * mm, top - 4.15 * mm, rendered)
        canvas_obj.restoreState()
        right -= bubble_width + 2 * mm


def _acoustic_model_label(recorded_model: object, lang: str) -> str:
    """Expose the deployed model identity only when an analysis recorded it."""
    if not recorded_model:
        return _label(lang, "غير مسجل", "Not recorded")
    return "Meta AI - wav2vec2-arabic-phoneme-asr"


def _report_metrics(context: dict) -> dict:
    session = context["session"]
    units = _analysis_units(context)
    analyzed = [item for item in units if item.get("analysis_status") == "ok"]
    uncertain = [item for item in units if item.get("uncertainty") or item.get("analysis_status") in {"failed", "insufficient_audio"}]
    candidates = [candidate for item in units for candidate in _unique_candidates(item.get("candidate_errors"))]
    confirmed = [item for item in session.get("observations", []) if item.get("verification_status") == "human_verified"]
    return {"units": units, "analyzed": analyzed, "uncertain": uncertain, "candidates": candidates, "confirmed": confirmed}


def _report_overview_page(canvas_obj, template, context, metrics, page, total, styles, font, lang):
    _report_header(canvas_obj, template, page, total, styles, font, lang, _label(lang, "1. تقرير الذكاء الاصطناعي للجلسة", "1. AI session report"), _label(lang, "مؤشرات صوتية قابلة للمراجعة - ليست تشخيصا طبيا", "Reviewable acoustic indicators - not a medical diagnosis"))
    session, profile = context["session"], context["profile"]
    model = _acoustic_model_label(
        (context.get("analysis", {}).get("model_versions") or {}).get("acoustic"), lang,
    )
    cards = [
        (_label(lang, "المتعلم", "Learner"), profile.get("display_name") or _label(lang, "اسم مستعار", "Pseudonym"), BLUE),
        (_label(lang, "تاريخ الجلسة", "Session date"), _session_date(session["started_at"]), TEAL),
        (_label(lang, "الوحدات المحللة", "Analyzed units"), f"{len(metrics['analyzed'])} / {len(metrics['units'])}", BLUE),
        (_label(lang, "نموذج صوتي", "Acoustic model"), str(model), TEAL),
    ]
    for index, (title, value, color) in enumerate(cards):
        column, row = index % 2, index // 2
        _report_box(canvas_obj, (28 + column * 77) * mm, (198 - row * 43) * mm, 72 * mm, 35 * mm, title, value, styles, lang, color)
    note = _label(lang, "يفصل هذا التقرير بين اقتراحات النموذج الآلية والملاحظات التي أكدها المرافق. لا يثبت الاقتراح الآلي وجود صعوبة في القراءة.", "This report separates automatic model suggestions from observations confirmed by a companion. An automatic suggestion does not establish a reading difficulty.")
    _report_box(canvas_obj, 28 * mm, 112 * mm, 150 * mm, 35 * mm, _label(lang, "كيفية القراءة", "How to read this report"), note, styles, lang, ORANGE)


def _individual_analysis_page(canvas_obj, template, context, units, page, total, styles, font, lang, page_index):
    _report_header(canvas_obj, template, page, total, styles, font, lang, _label(lang, "نتائج التحليل الفردية", "Individual acoustic analysis"), _label(lang, "النص المرجعي والقراءة المتعرف عليها والفونيمات والملاحظات", "Reference, recognized reading, phonemes, and observations"))
    start, shown = page_index * 3, units[page_index * 3:(page_index + 1) * 3]
    if not shown:
        _report_box(canvas_obj, 28 * mm, 190 * mm, 150 * mm, 35 * mm, _label(lang, "التحليل", "Analysis"), _label(lang, "بيانات غير كافية", "Insufficient data"), styles, lang, ORANGE); return
    for offset, item in enumerate(shown):
        y = (194 - offset * 57) * mm
        expected = " ".join(item.get("expected_phonemes") or []) or "-"
        predicted = " ".join(item.get("predicted_phonemes") or []) or "-"
        recognized = item.get("recognized_text") or item.get("observed_text") or "-"
        body = "\n".join((
            f"{_label(lang, 'المرجع', 'Reference')}: {item.get('reference_text') or '-'}",
            f"{_label(lang, 'القراءة المتعرف عليها', 'Recognized reading')}: {recognized}",
            f"{_label(lang, 'فونيمات المرجع', 'Reference phonemes')}: {expected}",
            f"{_label(lang, 'فونيمات النموذج', 'Model phonemes')}: {predicted}",
        ))
        _report_box(canvas_obj, 28 * mm, y, 150 * mm, 51 * mm, f"{start + offset + 1}. {item.get('reference_text') or item.get('text') or '-'}", body, styles, lang, BLUE if item.get("analysis_status") == "ok" else ORANGE)
        _report_remark_bubbles(canvas_obj, _candidate_remark_types(item.get("candidate_errors")), 28 * mm, y, 150 * mm, font, lang)


def _errors_page(canvas_obj, template, context, metrics, page, total, styles, font, lang):
    _report_header(canvas_obj, template, page, total, styles, font, lang, _label(lang, "الأخطاء والملاحظات الصوتية", "Phonemic errors and acoustic observations"), _label(lang, "تأكيد بشري ومقترحات ASR وحالات غير يقينية", "Human confirmation, ASR suggestions, and uncertain cases"))
    confirmed_by_type = Counter(item.get("error_type") for item in metrics["confirmed"] if item.get("error_type"))
    candidates_by_type = Counter(_candidate_type(item) for item in metrics["candidates"])
    rows = []
    for kind in sorted(set(confirmed_by_type) | set(candidates_by_type)):
        label = ERROR_LABELS.get(kind, (kind, kind))[0 if lang == "ar" else 1]
        rows.append((label, confirmed_by_type[kind], candidates_by_type[kind]))
    if rows:
        _report_chart(canvas_obj, 28 * mm, 198 * mm, 72 * mm, 74 * mm, [(label, count) for label, count, _ in rows], _label(lang, "ملاحظات مؤكدة", "Confirmed observations"), styles, font, lang, "")
        _report_chart(canvas_obj, 106 * mm, 198 * mm, 72 * mm, 74 * mm, [(label, count) for label, _, count in rows], _label(lang, "مقترحات ASR", "Potential ASR observations"), styles, font, lang, "")
    else:
        _report_box(canvas_obj, 28 * mm, 198 * mm, 150 * mm, 50 * mm, _label(lang, "التكرارات", "Frequencies"), _label(lang, "بيانات غير كافية: لا توجد ملاحظات محفوظة أو مقترحات قابلة للعرض.", "Insufficient data: no saved observations or displayable suggestions."), styles, lang, ORANGE)
    examples, seen_examples = [], set()
    for unit in metrics["units"]:
        reference = unit.get("reference_text") or unit.get("text") or "-"
        for candidate in _unique_candidates(unit.get("candidate_errors")):
            signature = (str(reference), json.dumps(candidate, ensure_ascii=False, sort_keys=True, default=str))
            if signature in seen_examples:
                continue
            seen_examples.add(signature)
            label = ERROR_LABELS.get(_candidate_type(candidate), (_candidate_type(candidate), _candidate_type(candidate)))[0 if lang == 'ar' else 1]
            examples.append(f"{reference}: {label}")
    note = _label(lang, "المثال المرتبط بالملاحظة المؤكدة لا يخزن حاليا في سجل التحقق؛ لذلك تعرض الأمثلة أدناه كمقترحات ASR مرتبطة بالنص المرجعي فقط.", "The item-level example for a confirmed observation is not currently retained in the verification record; the examples below are therefore ASR suggestions linked to the reference text only.")
    examples_body = "\n".join(examples[:4]) or _label(lang, "بيانات غير كافية", "Insufficient data")
    _report_box(canvas_obj, 28 * mm, 113 * mm, 150 * mm, 42 * mm, _label(lang, "أمثلة حقيقية من الجلسة (مقترحات ASR)", "Real session examples (ASR suggestions)"), examples_body + "\n" + note, styles, lang, ORANGE)


def _progress_page(canvas_obj, template, context, metrics, page, total, styles, font, lang):
    _report_header(canvas_obj, template, page, total, styles, font, lang, _label(lang, "التقدم والأداء", "Progress and performance"), _label(lang, "تعرض الرسوم فقط القياسات التي يمكن بناؤها من السجل المحفوظ", "Charts use only measurements available in the saved record"))
    history_values = []
    for index, session in enumerate(context.get("history", []), 1):
        attempts = session.get("attempts", [])
        total_items = sum(item.get("total_count", 0) for item in attempts)
        if total_items:
            history_values.append((str(index), 100 * sum(item.get("correct_count", 0) for item in attempts) / total_items))
    _report_chart(canvas_obj, 28 * mm, 196 * mm, 72 * mm, 75 * mm, history_values if len(history_values) >= 2 else [], _label(lang, "أداء الأنشطة حسب الجلسة", "Activity performance by session"), styles, font, lang)
    mastery = [event for event in context.get("mastery_events", []) if event.get("created_at") and event.get("created_at") >= context["session"]["started_at"]]
    before_after = []
    for event in mastery[:4]:
        skill = str(event.get("skill", "-"))[:10]
        before_after.append((f"{skill} B", 100 * float(event["previous_mastery"])))
        before_after.append((f"{skill} A", 100 * float(event["resulting_mastery"])))
    _report_chart(canvas_obj, 106 * mm, 196 * mm, 72 * mm, 75 * mm, before_after, _label(lang, "تقدير الإتقان قبل وبعد التمارين", "Estimated mastery before and after exercises"), styles, font, lang)
    candidate_rate = []
    for index, session in enumerate(context.get("history", []), 1):
        analyzed = [word for word in session.get("reading_words", []) if word.get("analysis_status") == "ok"]
        if analyzed:
            candidate_count = sum(len(word.get("candidate_errors") or []) for word in analyzed)
            candidate_rate.append((str(index), 100 * candidate_count / len(analyzed)))
    _report_box(canvas_obj, 28 * mm, 108 * mm, 150 * mm, 39 * mm, _label(lang, "معدل ملاحظات ASR", "ASR observation rate"), (", ".join(f"{name}: {value:.0f}%" for name, value in candidate_rate) if len(candidate_rate) >= 2 else _label(lang, "بيانات غير كافية لبناء معدل عبر الجلسات.", "Insufficient data to calculate a cross-session rate.")), styles, lang, ORANGE)
    _report_box(canvas_obj, 28 * mm, 61 * mm, 150 * mm, 30 * mm, _label(lang, "تفسير الرسم", "Chart interpretation"), _label(lang, "لا تقارن هذه الرسوم بين مقاييس مختلفة. معدل النشاط يقيس الإجابات المسجلة، ومعدل ASR يقيس المقترحات الآلية، والإتقان تقدير تربوي من التمارين فقط.", "These charts do not compare different measures. Activity performance uses saved answers, the ASR rate uses automatic suggestions, and mastery is an educational estimate derived from exercises only."), styles, lang, TEAL)


def _recommendations_page(canvas_obj, template, context, metrics, page, total, styles, font, lang):
    _report_header(canvas_obj, template, page, total, styles, font, lang, _label(lang, "توصيات تربوية قابلة للتفسير", "Explainable pedagogical recommendations"), _label(lang, "كل اختيار مرتبط ببيانات محفوظة أو يوضح غياب التبرير المحفوظ", "Each selection is tied to saved data or explicitly notes missing rationale"))
    confirmed_counts = Counter(item.get("error_type") for item in metrics["confirmed"] if item.get("error_type"))
    ranked = {kind: index + 1 for index, (kind, _) in enumerate(confirmed_counts.most_common())}
    exercises = context.get("exercises", [])
    if not exercises:
        _report_box(canvas_obj, 28 * mm, 195 * mm, 150 * mm, 40 * mm, _label(lang, "التمارين", "Exercises"), _label(lang, "بيانات غير كافية: لا توجد توصيات محفوظة لهذه الجلسة.", "Insufficient data: no recommendations are saved for this session."), styles, lang, ORANGE); return
    for index, exercise in enumerate(exercises[:4]):
        error_type = exercise.get("error_type")
        confirmed_count = confirmed_counts.get(error_type, 0)
        priority = f"P{ranked[error_type]}" if error_type in ranked else _label(lang, "غير متاح", "Not available")
        error_label = ERROR_LABELS.get(error_type, (str(error_type or "-"), str(error_type or "-")))[0 if lang == "ar" else 1]
        body = "\n".join((
            f"{_label(lang, 'الصعوبة المستهدفة', 'Target difficulty')}: {error_label}",
            f"{_label(lang, 'المهارة', 'Skill')}: {exercise.get('skill') or '-'} | {_label(lang, 'المستوى', 'Level')}: {exercise.get('level') or '-'}",
            f"{_label(lang, 'التبرير', 'Rationale')}: {confirmed_count} {_label(lang, 'ملاحظة مؤكدة مرتبطة', 'linked confirmed observation(s)') if confirmed_count else _label(lang, 'ملاحظة مؤكدة محفوظة مرتبطة', 'linked saved confirmed observation') + ': 0'}",
            f"{_label(lang, 'الأولوية', 'Priority')}: {priority}",
            f"{_label(lang, 'الهدف التربوي', 'Pedagogical objective')}: {exercise.get('title_fr') or exercise.get('skill') or '-'}",
        ))
        _report_box(canvas_obj, 28 * mm, (196 - index * 41) * mm, 150 * mm, 36 * mm, f"{index + 1}. {exercise.get('id') or '-'}", body, styles, lang, BLUE if confirmed_count else ORANGE)


def _synthesis_page(canvas_obj, template, context, metrics, page, total, styles, font, lang):
    _report_header(canvas_obj, template, page, total, styles, font, lang, _label(lang, "الخلاصة الشخصية", "Personalized synthesis"), _label(lang, "تفسير تربوي محافظ مبني على ما هو محفوظ فقط", "A cautious educational interpretation based only on saved information"))
    attempts = context["session"].get("attempts", [])
    correct, total_items = sum(item.get("correct_count", 0) for item in attempts), sum(item.get("total_count", 0) for item in attempts)
    strengths = []
    if metrics["analyzed"]: strengths.append(_label(lang, f"يتوفر تحليل صوتي قابل للمراجعة لـ {len(metrics['analyzed'])} وحدة.", f"A reviewable acoustic analysis is available for {len(metrics['analyzed'])} unit(s)."))
    if total_items: strengths.append(_label(lang, f"تم تسجيل {correct} إجابة صحيحة من {total_items} في الأنشطة.", f"{correct} correct response(s) out of {total_items} were saved in activities."))
    if not strengths: strengths.append(_label(lang, "بيانات غير كافية لتحديد نقاط قوة موثقة.", "Insufficient data to identify documented strengths."))
    persistent = Counter(item.get("error_type") for item in metrics["confirmed"] if item.get("error_type"))
    persistent_text = ", ".join(f"{ERROR_LABELS.get(kind, (kind, kind))[0 if lang == 'ar' else 1]} ({count})" for kind, count in persistent.items()) or _label(lang, "لا توجد ملاحظة مؤكدة محفوظة.", "No confirmed observation is saved.")
    progress = [event for event in context.get("mastery_events", []) if float(event.get("resulting_mastery", 0)) > float(event.get("previous_mastery", 0))]
    progress_text = _label(lang, f"سجلت زيادة في تقدير الإتقان لـ {len(progress)} مهارة/مهارات بعد الأنشطة.", f"An increase in estimated mastery was saved for {len(progress)} skill(s) after activities.") if progress else _label(lang, "بيانات غير كافية لإثبات تقدم بين قياسين محفوظين.", "Insufficient data to demonstrate progress between saved measurements.")
    next_step = _label(lang, "راجع نتائج الجلسة مع المرافق، ثم نفذ التمارين المختارة بهدوء وسجل المحاولات الجديدة للمقارنة في جلسة لاحقة.", "Review session results with the companion, complete the selected activities calmly, then save new attempts for comparison in a later session.")
    _report_box(canvas_obj, 28 * mm, 195 * mm, 150 * mm, 36 * mm, _label(lang, "نقاط القوة", "Strengths"), "\n".join(strengths), styles, lang, TEAL)
    _report_box(canvas_obj, 28 * mm, 151 * mm, 150 * mm, 36 * mm, _label(lang, "صعوبات تحتاج متابعة", "Difficulties to monitor"), persistent_text, styles, lang, ORANGE)
    _report_box(canvas_obj, 28 * mm, 107 * mm, 150 * mm, 36 * mm, _label(lang, "تقدم ملحوظ", "Observed progress"), progress_text, styles, lang, BLUE)
    _report_box(canvas_obj, 28 * mm, 63 * mm, 150 * mm, 36 * mm, _label(lang, "الخطوة التالية", "Recommended next step"), next_step, styles, lang, TEAL)


def _guide_divider_page(canvas_obj, template, page, total, styles, font, lang):
    _guide_page(canvas_obj, template, page, total, font)
    _guide_paragraph(canvas_obj, _label(lang, "2. الدليل التربوي الشخصي", "2. Personalized pedagogical guide"), styles["h1"], 28 * mm, 205 * mm, 150 * mm, lang)
    _report_box(canvas_obj, 28 * mm, 165 * mm, 150 * mm, 60 * mm, _label(lang, "من التقرير إلى الممارسة", "From report to practice"), _label(lang, "تبدأ هنا الأنشطة المطبوعة الموجودة سابقا في الدليل. تنفذ مع مرافق تربوي، ولا تتطلب تسجيل صوت الطفل داخل التطبيق.", "The existing printable activities begin here. They are completed with an educational companion and do not require recording the child's voice in the application."), styles, lang, TEAL)


def build_learning_guide(session_id: str, lang: str = "ar") -> bytes:
    """Generate a print-ready A4 report and personalised pedagogical guide."""
    if lang not in {"ar", "en"}:
        raise ValueError("lang must be ar or en")
    if not COVER_IMAGE.is_file() or not PAGE_TEMPLATE_IMAGE.is_file():
        raise RuntimeError("Les modèles visuels du guide sont introuvables.")
    context = report_context(session_id)
    font, bold = _register_fonts()
    styles = _styles(font, bold, lang)
    stream = BytesIO()
    pdf = canvas.Canvas(stream, pagesize=A4, pageCompression=1)
    pdf.setTitle("AcoDyslex - " + ("الدليل التربوي الشخصي" if lang == "ar" else "Personalized Learning Guide"))
    metrics = _report_metrics(context)
    analysis_pages = max(1, ceil(len(metrics["units"]) / 3))
    # Cover + six IA-report sections + analysis detail pages + guide divider +
    # learner card + activities summary + printable activities + closing page.
    total = 17 + analysis_pages
    cover, template = ImageReader(str(COVER_IMAGE)), ImageReader(str(PAGE_TEMPLATE_IMAGE))
    # Cover is supplied as a full A4 composition and must remain free of overlays.
    page = 1
    pdf.drawImage(cover, 0, 0, width=PAGE_WIDTH, height=PAGE_HEIGHT, mask="auto")
    pdf.showPage()

    page += 1
    _report_overview_page(pdf, template, context, metrics, page, total, styles, font, lang)
    pdf.showPage()
    for page_index in range(analysis_pages):
        page += 1
        _individual_analysis_page(pdf, template, context, metrics["units"], page, total, styles, font, lang, page_index)
        pdf.showPage()
    page += 1
    _errors_page(pdf, template, context, metrics, page, total, styles, font, lang)
    pdf.showPage()
    page += 1
    _progress_page(pdf, template, context, metrics, page, total, styles, font, lang)
    pdf.showPage()
    page += 1
    _recommendations_page(pdf, template, context, metrics, page, total, styles, font, lang)
    pdf.showPage()
    page += 1
    _synthesis_page(pdf, template, context, metrics, page, total, styles, font, lang)
    pdf.showPage()
    page += 1
    _guide_divider_page(pdf, template, page, total, styles, font, lang)
    pdf.showPage()

    page += 1
    _profile_page(pdf, template, context, page, total, styles, font, lang)
    pdf.showPage()
    page += 1
    _activities_summary_page(pdf, template, page, total, styles, font, lang)
    pdf.showPage()
    for index, activity in enumerate(PRINTABLE_ACTIVITIES, 1):
        page += 1
        _activity_page(pdf, template, activity, index, page, total, styles, font, lang)
        pdf.showPage()
    page += 1
    _closing_page(pdf, page, total, font, bold, lang)
    pdf.save()
    return stream.getvalue()
