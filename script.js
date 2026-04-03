// ===== شريط التنقل - فتح/إغلاق =====
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');

navToggle.addEventListener('click', () => {
  navLinks.classList.toggle('open');
});

// إغلاق القائمة عند الضغط على رابط
navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('open');
  });
});

// ===== تأثير شريط التنقل عند التمرير =====
window.addEventListener('scroll', () => {
  const nav = document.querySelector('nav');
  if (window.scrollY > 50) {
    nav.style.padding = '0.7rem 2rem';
    nav.style.background = 'rgba(22, 33, 62, 0.98)';
  } else {
    nav.style.padding = '1rem 2rem';
    nav.style.background = 'rgba(26, 26, 46, 0.85)';
  }
});

// ===== عداد الإحصائيات =====
function animateCounter(el, target, duration = 2000) {
  let start = 0;
  const step = target / (duration / 16);
  const timer = setInterval(() => {
    start += step;
    if (start >= target) {
      el.textContent = target.toLocaleString('ar') + (el.dataset.suffix || '');
      clearInterval(timer);
    } else {
      el.textContent = Math.floor(start).toLocaleString('ar') + (el.dataset.suffix || '');
    }
  }, 16);
}

// ===== ظهور العناصر عند التمرير =====
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry, index) => {
    if (entry.isIntersecting) {
      setTimeout(() => {
        entry.target.classList.add('visible');
      }, index * 100);
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.15 });

document.querySelectorAll('.reveal').forEach(el => {
  revealObserver.observe(el);
});

// ===== تشغيل عداد الإحصائيات =====
const statsObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      document.querySelectorAll('.stat-number').forEach(el => {
        const target = parseInt(el.dataset.target, 10);
        animateCounter(el, target);
      });
      statsObserver.disconnect();
    }
  });
}, { threshold: 0.5 });

const statsSection = document.getElementById('stats');
if (statsSection) statsObserver.observe(statsSection);

// ===== نموذج التواصل =====
const contactForm = document.getElementById('contactForm');
if (contactForm) {
  contactForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = contactForm.querySelector('.form-submit');
    const success = document.getElementById('formSuccess');

    btn.textContent = 'جاري الإرسال...';
    btn.disabled = true;

    setTimeout(() => {
      contactForm.reset();
      btn.textContent = 'إرسال الرسالة ✓';
      btn.style.background = 'linear-gradient(135deg, #43e97b, #38f9d7)';
      if (success) {
        success.style.display = 'block';
      }
      setTimeout(() => {
        btn.textContent = 'إرسال الرسالة';
        btn.style.background = '';
        btn.disabled = false;
        if (success) success.style.display = 'none';
      }, 4000);
    }, 1500);
  });
}

// ===== تأثير تموج الخلفية =====
document.addEventListener('mousemove', (e) => {
  const hero = document.getElementById('hero');
  if (!hero) return;
  const x = (e.clientX / window.innerWidth - 0.5) * 20;
  const y = (e.clientY / window.innerHeight - 0.5) * 20;
  hero.style.backgroundPosition = `${50 + x * 0.3}% ${50 + y * 0.3}%`;
});
