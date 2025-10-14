window.addEventListener('DOMContentLoaded', () => {
  const ctx = document.getElementById('songTimeline').getContext('2d');

  new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'Elena Cohen Releases',
          data: [
            { x: 2010.43, y: 8, label: 'Dreaming Wide Awake\nJun 3, 2010' },
            { x: 2011.97, y: 7, label: 'The Lucky Ones\nDec 16, 2011' },
            { x: 2014.02, y: 6, label: 'Lover and Daughter\nJan 9, 2014' }
          ],
          backgroundColor: '#4da6ff',
          borderColor: '#4da6ff',
          pointRadius: 10,
          pointHoverRadius: 12,
          showLine: false
        },
        {
          label: 'Mainstream Hits',
          data: [
            { x: 2012.40, y: 5, label: 'Katy Perry\nWide Awake\nMay 22, 2012' },
            { x: 2012.81, y: 4, label: 'Taylor Swift\nThe Lucky One\nOct 22, 2012' },
            { x: 2013.71, y: 3, label: 'Lorde - Team\nSep 13, 2013' },
            { x: 2014.74, y: 2, label: 'Lorde\nYellow Flicker Beat\nSep 29, 2014' },
            { x: 2021.00, y: 1, label: 'Lorde\nLeader of New Regime\n2021 (Video)' }
          ],
          backgroundColor: '#ff4d4d',
          borderColor: '#ff4d4d',
          pointRadius: 8,
          pointHoverRadius: 10,
          showLine: false
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: 'Song Release Timeline: Blue = Elena Cohen | Red = Mainstream Hits',
          font: { size: 16 },
          color: '#ffffff'
        },
        legend: {
          labels: {
            color: '#e0e0e0',
            font: { size: 12 }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return context.raw.label || context.label;
            }
          },
          backgroundColor: 'rgba(0,0,0,0.8)',
          titleColor: '#ffffff',
          bodyColor: '#e0e0e0'
        }
      },
      scales: {
        x: {
          type: 'linear',
          position: 'bottom',
          min: 2010,
          max: 2022,
          title: {
            display: true,
            text: 'Year',
            color: '#e0e0e0'
          },
          ticks: {
            color: '#b0b0b0',
            stepSize: 1
          },
          grid: {
            color: 'rgba(255,255,255,0.1)'
          }
        },
        y: {
          min: 0,
          max: 9,
          ticks: {
            display: false
          },
          grid: {
            color: 'rgba(255,255,255,0.1)'
          }
        }
      }
    },
    plugins: [{
      id: 'connectionLines',
      afterDatasetsDraw(chart) {
        const ctx = chart.ctx;
        ctx.save();
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);

        const elenaMeta = chart.getDatasetMeta(0).data;
        const mainstreamMeta = chart.getDatasetMeta(1).data;

        function drawConnection(fromIdx, toIdx) {
          const from = elenaMeta[fromIdx];
          const to = mainstreamMeta[toIdx];
          if (from && to) {
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(to.x, to.y);
            ctx.stroke();
          }
        }

        drawConnection(0, 0); // Dreaming Wide Awake → Wide Awake
        drawConnection(1, 1); // The Lucky Ones → The Lucky One
        drawConnection(2, 2); // Lover and Daughter → Team
        drawConnection(2, 3); // Lover and Daughter → Yellow Flicker Beat
        drawConnection(2, 4); // Lover and Daughter → Leader of New Regime

        ctx.restore();
      }
    }]
  });
});
