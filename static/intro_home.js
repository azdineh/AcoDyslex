/* Entry screen displayed before the profile workspace. */
(() => {
  const copy = {
    ar: {
      kicker: 'تحليل صوتي للقراءة العربية',
      title: 'اكتشاف أخطاء القراءة لمرافقة الطفل بشكل أفضل',
      description: 'يحلّل AcoDyslex خصائص القراءة الصوتية لرصد أخطاء محتملة لدى الأطفال الذين يواجهون صعوبات في القراءة، بمن فيهم الأطفال ذوو عسر القراءة. تبقى النتائج مؤشرات تحتاج إلى مراجعة مختص أو مرافق مؤهل.',
      model: 'كشف صوتي لأخطاء القراءة',
      start: 'ابدأ الآن',
      technology: 'تقنية التحليل'
      ,prototypeKicker: 'منصة مرافقة للمتخصصين',
      prototypeTitle: 'نموذج أولي لمنصة دعم متخصصة',
      prototypeFirst: 'هذه النسخة نموذج أولي لمنصة رقمية تساند المتخصصين في مراكز تحليل عسر القراءة، وتساعدهم على فهم مؤشرات القراءة بصورة أوضح.',
      prototypeSecond: 'تعتمد المنصة على نماذج ذكاء اصطناعي متقدمة لتوليد مسارات تعلّم مخصصة وتدريجية، مكيّفة مع احتياجات كل طفل وقدراته.'
    },
    en: {
      prototypeKicker: 'A platform for specialists',
      prototypeTitle: 'A prototype for specialist support',
      prototypeFirst: 'This prototype illustrates a digital platform that supports specialists in dyslexia analysis centers and helps them understand reading indicators more clearly.',
      prototypeSecond: 'It uses advanced AI models to generate progressive, personalized learning pathways tailored to every child’s needs and abilities.',
      kicker: 'Acoustic analysis of Arabic reading',
      title: 'Detect reading errors to provide better support',
      description: 'AcoDyslex analyzes the acoustic characteristics of reading to flag potential errors in children with reading difficulties, including dyslexia. Results are indicators that require review by a qualified adult or professional.',
      model: 'Acoustic detection of reading errors',
      start: 'Start',
      technology: 'Analysis technology'
    }
  };

  function render() {
    const language = document.documentElement.lang === 'en' ? 'en' : 'ar';
    const text = copy[language];
    if (language === 'ar') {
      text.title = '\u0646\u0645\u0648\u0630\u062c \u0623\u0648\u0644\u064a \u0644\u0645\u0646\u0635\u0629 \u062f\u0639\u0645 \u0645\u062a\u062e\u0635\u0635\u0629';
      text.prototypeTitle = '\u0627\u0643\u062a\u0634\u0627\u0641 \u0623\u062e\u0637\u0627\u0621 \u0627\u0644\u0642\u0631\u0627\u0621\u0629 \u0644\u0645\u0631\u0627\u0641\u0642\u0629 \u0627\u0644\u0637\u0641\u0644 \u0628\u0634\u0643\u0644 \u0623\u0641\u0636\u0644';
    } else {
      text.title = 'A prototype for specialist support';
      text.prototypeTitle = 'Detect reading errors to provide better support';
    }
    const modelSummary = language === 'en' ? {
      label: 'Acoustic model', typeLabel: 'Type', typeValue: 'Arabic speech phoneme recognition',
      baseLabel: 'Meta AI base model', baseValue: 'facebook/wav2vec2-large-xlsr-53', arabicLabel: 'Arabic adaptation', arabicValue: 'Modern Standard Arabic', hostLabel: 'Hosting'
    } : {
      label: '\u0627\u0644\u0646\u0645\u0648\u0630\u062c \u0627\u0644\u0635\u0648\u062a\u064a', typeLabel: '\u0627\u0644\u0646\u0648\u0639', typeValue: '\u062a\u0639\u0631\u0641 \u0641\u0648\u0646\u064a\u0645\u064a \u0644\u0644\u0643\u0644\u0627\u0645 \u0627\u0644\u0639\u0631\u0628\u064a',
      baseLabel: '\u0627\u0644\u0646\u0645\u0648\u0630\u062c \u0627\u0644\u0623\u0633\u0627\u0633\u064a \u0645\u0646 Meta AI', baseValue: 'facebook/wav2vec2-large-xlsr-53', arabicLabel: '\u0627\u0644\u062a\u0643\u064a\u0651\u0641 \u0627\u0644\u0639\u0631\u0628\u064a', arabicValue: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629 \u0627\u0644\u0641\u0635\u062d\u0649', hostLabel: '\u0627\u0644\u0627\u0633\u062a\u0636\u0627\u0641\u0629'
    };
    document.getElementById('intro-kicker').textContent = text.kicker;
    document.getElementById('intro-title').textContent = text.title;
    document.getElementById('intro-description').textContent = text.description;
    document.getElementById('intro-model-copy').textContent = text.model;
    document.querySelector('.intro-model').setAttribute('aria-label', text.technology);
    document.getElementById('intro-start').textContent = text.start;
    document.getElementById('intro-prototype-kicker').textContent = text.prototypeKicker;
    document.getElementById('intro-prototype-title').textContent = text.prototypeTitle;
    document.getElementById('intro-prototype-first').textContent = text.prototypeFirst;
    document.getElementById('intro-prototype-second').textContent = text.prototypeSecond;
    document.querySelectorAll('[data-model-summary]').forEach(element => { element.textContent = modelSummary[element.dataset.modelSummary]; });
  }

  async function init() {
    await window.acodyslexI18n?.ready;
    render();
    const intro = document.getElementById('intro-home');
    const workspace = document.getElementById('app-shell');
    const showWorkspace = () => {
      intro.hidden = true;
      workspace.hidden = false;
      window.scrollTo({top: 0, behavior: 'smooth'});
    };
    const showWelcome = () => {
      workspace.hidden = true;
      intro.hidden = false;
      window.scrollTo({top: 0, behavior: 'smooth'});
    };
    document.getElementById('intro-start').addEventListener('click', showWorkspace);
    document.getElementById('profile-welcome')?.addEventListener('click', showWelcome);
    const slides = [...document.querySelectorAll('[data-intro-slide]')];
    const dots = [...document.querySelectorAll('[data-intro-page]')];
    let activeIntroPage = 0;
    let introCarouselTimer = null;
    const setIntroPage = index => {
      activeIntroPage = index;
      slides.forEach((slide, position) => {
        const active = position === index;
        slide.hidden = false;
        slide.classList.toggle('is-active', active);
        slide.setAttribute('aria-hidden', String(!active));
      });
      dots.forEach((dot, position) => {
        const active = position === index;
        dot.classList.toggle('is-active', active);
        dot.setAttribute('aria-selected', String(active));
      });
    };
    const startIntroCarousel = () => {
      clearInterval(introCarouselTimer);
      introCarouselTimer = setInterval(() => setIntroPage((activeIntroPage + 1) % slides.length), 5000);
    };
    dots.forEach((dot, index) => dot.addEventListener('click', () => { setIntroPage(index); startIntroCarousel(); }));
    setIntroPage(0);
    startIntroCarousel();
    document.addEventListener('visibilitychange', () => document.hidden ? clearInterval(introCarouselTimer) : startIntroCarousel());
    if (window.__ACODYSLEX_TEST_WORKSPACE__ || window.__ACODYSLEX_TEST_SOURCE_UI__) {
      intro.hidden = true;
      workspace.hidden = false;
      return;
    }
    window.addEventListener('acodyslex:languagechange', render);
  }

  init();
})();
