let current = 0;
const testimonials = document.querySelectorAll('.testimonial');
const total = testimonials.length;

function showNext() {
  testimonials[current].classList.remove('active');
  current = (current + 1) % total;
  testimonials[current].classList.add('active');
}

setInterval(showNext, 4000); // Change testimonial every 4 seconds



